// The buyback, carried out by the droplet itself. The creator opted in with
// strats init or strats config auto-buyback, on a terminal, and strats deploy
// then sent the droplet what it needs to withdraw and swap. That opt-in is the
// consent: there is no terminal here and no question is asked. So this file
// refuses unless the bot file says autoBuyback AND the process runs from the
// runtime credentials strats deploy wrote.
//
// Nothing here is new money logic. The profit arithmetic is plan.ts, the quote
// checks are lifi.ts, the gas check is chain.ts, and the recorded sequence, with
// every way of stopping and continuing, is machine.ts: the same code strats
// buyback --execute runs. It never runs inside a trading cycle, never two at a
// time, and an error costs one log line and a wait until the next check.
import { randomBytes } from "node:crypto";
import { fetchTarget } from "../client.js";
import { appendLedger, readLedger, summarize, type Ledger, type LedgerLine } from "../payouts.js";
import { usd } from "../reconcile.js";
import { loadWalletKey, scrub, sessionSecrets, type Session } from "../session.js";
import { isPolymarketBot } from "../state.js";
import { loadBasis, mergeBasisLedger, type BuybackBasis } from "./basis.js";
import { SOURCE_CHAINS, chainWallet, checkGas, type ChainWallet } from "./chain.js";
import { fileJournal, type JournalStore } from "./journal.js";
import { checkQuote, fetchQuote, fetchStatus, floorFrom, type QuoteExpectation, type QuoteRequest, type QuoteResult, type StatusExpectation, type SwapStatus } from "./lifi.js";
import { resumePayout, startPayout, tokenAmount, type BuybackDeps, type Outcome } from "./machine.js";
import { MAX_IMPACT_DEFAULT, MIN_USD_DEFAULT, SLIPPAGE_DEFAULT, planBuyback, refusalText } from "./plan.js";
import { SUPPORTED_TOKEN_CHAINS, chainLabel } from "./text.js";
import { BuybackRefusal, hyperliquidVenue, polymarketVenue, type BuybackVenuePort } from "./venues.js";

/** The first check after the runner starts, and the wait between checks. */
export const AUTO_FIRST_MS = 10 * 60_000;
export const AUTO_EVERY_MS = 24 * 60 * 60_000;
/** Every line of the unattended buyback starts with this word, so strats status can find the last one. */
export const AUTO_TAG = "buyback";

/** The command's own defaults. Unattended, nothing can raise them. */
export const AUTO_SETTINGS = { minUsd: MIN_USD_DEFAULT, slippagePct: SLIPPAGE_DEFAULT, maxImpactPct: MAX_IMPACT_DEFAULT } as const;

export class AutoBuybackRefused extends Error {}

/** The two conditions for paying out with nobody watching. Checked before anything is read, and again where the machine would have asked a person. */
export function assertUnattendedAllowed(session: Pick<Session, "bot" | "runtime">): void {
  if (session.bot.autoBuyback !== true) throw new AutoBuybackRefused("Auto-buyback is off for this bot, so nothing is paid out unattended. To turn it on: strats config auto-buyback on, then strats deploy.");
  if (!session.runtime) throw new AutoBuybackRefused("The automatic buyback runs only on the droplet, from the credentials strats deploy sent. On this machine, use: strats buyback --execute");
}

export interface AutoPorts {
  venue: BuybackVenuePort;
  wallet: ChainWallet;
  journal: JournalStore;
  ledger: { read(): Ledger; has(type: LedgerLine["type"], id: string): boolean; append(line: LedgerLine): void };
  /** What strats deploy sent: the deposits figure and the earlier buybacks. Null when the droplet has none, and then nothing is paid. */
  basis(): BuybackBasis | null;
  fetchQuote(request: QuoteRequest): Promise<QuoteResult>;
  fetchStatus(expect: StatusExpectation): Promise<SwapStatus>;
  clock: { now(): number; sleep(ms: number): Promise<void> };
  /** One plain log line. */
  say(text: string): void;
  newId(): string;
  /** Hyperliquid only: the dex a new payout takes the money from. */
  dex?: string;
}

/** On the droplet nobody can run a command, so the machine's "run it again" reads as what happens next. */
const unattendedWording = (text: string): string => text.replace(/Run (?:strats buyback --execute|it) again(?: in a few minutes)?/g, "The droplet continues it at its next check");

/**
 * One unattended check: continue a buyback that is part-way, otherwise measure the profit and, when the buyback share
 * clears the minimum and the quote and the gas pass every check, carry it out. Returns the machine's outcome, or null
 * when there was nothing to pay or a check refused. It throws only for the caller to log.
 */
export async function runUnattended(session: Pick<Session, "bot" | "runtime">, ports: AutoPorts): Promise<Outcome | null> {
  assertUnattendedAllowed(session);
  const { bot } = session;
  const say = (text: string): void => ports.say(unattendedWording(text));
  const venueName = ports.venue.name;
  const source = SOURCE_CHAINS[venueName];
  const { minUsd, slippagePct, maxImpactPct } = AUTO_SETTINGS;

  // Without what strats deploy sent, the droplet cannot know what was already split, so it pays nothing.
  const basis = ports.basis();
  if (!basis) {
    say("Nothing is paid: the droplet has no record of earlier buybacks and deposits. On your own machine run: strats deploy");
    return null;
  }
  if (basis.hold === true) {
    say("Paused while strats fund records a deposit. It resumes when strats fund finishes on your own machine.");
    return null;
  }

  const expectation = (token: { chainId: number; address: string }, destination: string, amount: bigint, floorMinOut?: bigint): QuoteExpectation => ({
    fromChainId: source.chainId, toChainId: token.chainId, fromToken: source.token, toToken: token.address, fromAmount: amount,
    fromAddress: bot.masterAddress, toAddress: destination, slippagePct, maxImpactPct, ...(floorMinOut !== undefined ? { floorMinOut } : {}),
  });
  const deps = (token: { chainId: number; address: string }, destination: string): BuybackDeps => ({
    venue: ports.venue, wallet: ports.wallet,
    lifi: {
      async quote(amount, floorMinOut) {
        const fetched = await ports.fetchQuote(expectation(token, destination, amount));
        if (!fetched.ok) return { ok: false, reasons: [fetched.message] };
        const failures = checkQuote(fetched.quote, expectation(token, destination, amount, floorMinOut));
        return failures.length === 0 ? { ok: true, quote: fetched.quote } : { ok: false, reasons: failures };
      },
      status: (txHash) => ports.fetchStatus({ txHash, fromChainId: source.chainId, toChainId: token.chainId, toToken: token.address, toAddress: destination }),
    },
    clock: ports.clock,
    journal: ports.journal,
    ledger: { has: ports.ledger.has, append: ports.ledger.append },
    // The record and its totals are on this droplet already; there is nobody else to tell.
    sync: () => undefined,
    print: say,
    progress: () => undefined,
    // Where the command asks a person, the opt-in answers, and only while both conditions still hold.
    confirm: async () => {
      assertUnattendedAllowed(session);
      return true;
    },
    describeQuote: (quote) => [`A new quote promises at least ${tokenAmount(quote.estimate.toAmountMin, quote.action.toToken.decimals)} ${quote.action.toToken.symbol}, within ${slippagePct}% slippage and ${maxImpactPct}% price impact.`],
    tokenChainName: chainLabel(token.chainId),
  });

  const open = ports.journal.load();
  if (open) {
    const outcome = await resumePayout(deps(open.token, open.destination), open);
    // "replan": it was confirmed and nothing was sent. The record is gone, so the plan is made again from what is pinned now.
    if (outcome.code !== "replan") return outcome;
  }

  const token = bot.pinned.token;
  const destination = bot.pinned.destination ?? bot.masterAddress;
  if (!(SUPPORTED_TOKEN_CHAINS as readonly number[]).includes(token.chainId)) {
    say(`Nothing is paid: the pinned token is on ${chainLabel(token.chainId)}, and buybacks work for tokens on Ethereum, Base and Arbitrum.`);
    return null;
  }
  if (bot.pinned.split.buybackPct + bot.pinned.split.keepPct !== 100) {
    say("Nothing is paid: the pinned split does not add up to 100%.");
    return null;
  }

  const ledger = ports.ledger.read();
  if (ledger.skipped > 0) {
    say(`Nothing is paid: ${ledger.skipped} line${ledger.skipped === 1 ? "" : "s"} of the payout record could not be read, so what was already split is not known.`);
    return null;
  }
  const payouts = summarize(ledger.lines);
  let figures;
  try {
    figures = await ports.venue.figures(payouts);
  } catch (error) {
    if (!(error instanceof BuybackRefusal)) throw error;
    say(`Nothing is paid: ${error.message}`);
    return null;
  }
  const plan = planBuyback({ venue: venueName, ...figures, settledUsd: payouts.settledUsd, buybackPct: bot.pinned.split.buybackPct, minUsd });
  const refusal = refusalText(plan, usd);
  if (refusal) {
    say(`Profit to split ${usd(plan.distributableUsd)}. ${refusal}`);
    return null;
  }

  const fetched = await ports.fetchQuote(expectation(token, destination, plan.arriveUnits));
  if (!fetched.ok) {
    say(`${fetched.message} Nothing was sent.`);
    return null;
  }
  const { quote } = fetched;
  const failures = checkQuote(quote, expectation(token, destination, plan.arriveUnits));
  if (failures.length > 0) {
    say(`The quote was refused: ${failures.join("; ")}. Nothing was sent.`);
    return null;
  }
  // Money does not leave the venue until the wallet is known to hold gas for the swap. A failed read throws, and nothing was sent.
  const gas = await checkGas(ports.wallet, quote, plan.arriveUnits);
  if (!gas.enough) {
    say(`Nothing was sent. The wallet needs gas before money leaves ${ports.venue.label}: send about ${gas.shortfallText} ${source.nativeSymbol} on ${source.chainName} to ${bot.masterAddress}.`);
    return null;
  }

  const floorMinOut = floorFrom(quote);
  say(`Profit to split ${usd(plan.distributableUsd)}. Withdrawing ${usd(plan.withdrawUsd)} from ${ports.venue.label} to buy at least ${tokenAmount(floorMinOut, quote.action.toToken.decimals)} ${quote.action.toToken.symbol} for ${destination}.`);
  assertUnattendedAllowed(session);
  return startPayout(deps(token, destination), {
    id: ports.newId(), ...(venueName === "hyperliquid" && ports.dex !== undefined ? { dex: ports.dex } : {}),
    withdrawUsd: plan.withdrawUsd, feeUsd: plan.feeUsd, arriveUnits: plan.arriveUnits,
    profitSettledUsd: plan.profitSettledUsd, buybackPct: plan.buybackPct, token, destination, floorMinOut,
    tokenSymbol: quote.action.toToken.symbol, tokenDecimals: quote.action.toToken.decimals,
  });
}

export interface AutoTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: AutoTimers = {
  set: (run, ms) => {
    const timer = setTimeout(run, ms);
    // The trading loops keep the process alive. This timer never does.
    timer.unref();
    return timer;
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const oneLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);

export interface CheckSchedule {
  stop(): void;
  /** One check, as the timer runs it. */
  tick(): Promise<void>;
}

/**
 * Beside the trading loops, never inside one: a first check 10 minutes after the runner starts and one every 24 hours after.
 * One at a time. The next check is booked before this one runs, so a check that fails or takes long never ends the schedule,
 * and whatever it throws costs one log line. The next check is the retry.
 */
export function scheduleChecks(check: () => Promise<void>, say: (text: string) => void, opts: { firstMs?: number; everyMs?: number; timers?: AutoTimers } = {}): CheckSchedule {
  const timers = opts.timers ?? realTimers;
  const everyMs = opts.everyMs ?? AUTO_EVERY_MS;
  let running = false;
  let stopped = false;
  let handle: unknown;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    handle = timers.set(() => void tick(), everyMs);
    if (running) {
      say("The last check is still running, so this one is skipped.");
      return;
    }
    running = true;
    try {
      await check();
    } catch (error) {
      try {
        say(`${error instanceof AutoBuybackRefused ? "Refused." : "Error."} ${oneLine(error)} Nothing new is tried until the next check.`);
      } catch {
        // A log line that cannot be written must not reach the trading loops either.
      }
    } finally {
      running = false;
    }
  };
  handle = timers.set(() => void tick(), opts.firstMs ?? AUTO_FIRST_MS);
  return {
    stop: () => {
      stopped = true;
      timers.clear(handle);
    },
    tick,
  };
}

/** The real venue, wallet, files and LI.FI, for the droplet. Built afresh for every check, so nothing is carried from one day to the next. */
export async function dropletPorts(session: Session, say: (text: string) => void): Promise<AutoPorts> {
  assertUnattendedAllowed(session);
  const { bot } = session;
  const journal = fileJournal(bot.id);
  // What the creator's machine paid out before is added to this droplet's record first, so it is never paid again.
  const basis = loadBasis(bot.id);
  if (basis) mergeBasisLedger(bot.id, basis);
  const signerPk = loadWalletKey(session);
  if (!signerPk) throw new Error("The droplet was not sent the wallet key a buyback needs. On your own machine run: strats deploy");

  let venue: BuybackVenuePort;
  let dex: string | undefined;
  if (isPolymarketBot(bot)) {
    venue = polymarketVenue(session, undefined, () => loadBasis(bot.id) ?? {});
  } else {
    // A buyback that is part-way names its own dex. A new one takes the money from the dex the asset trades on, as the command does.
    dex = journal.load()?.dex;
    if (dex === undefined) {
      const target = await fetchTarget(session.gateway);
      if (!target.ok) throw new Error(`The target could not be read to learn which Hyperliquid dex the money is on. ${target.message}`);
      dex = target.value.target.dex;
    }
    if (dex !== "" && !/^[a-z][a-z0-9_-]{0,31}$/.test(dex)) throw new Error(`"${dex}" is not a valid dex name.`);
    venue = hyperliquidVenue(session, dex);
  }

  return {
    venue, wallet: chainWallet(venue.name, bot.masterAddress, signerPk), journal,
    ledger: {
      read: () => readLedger(bot.id),
      has: (type, id) => readLedger(bot.id).lines.some((l) => l.type === type && l.id === id),
      append: (line) => void appendLedger(bot.id, line),
    },
    basis: () => loadBasis(bot.id),
    fetchQuote: (request) => fetchQuote(request),
    fetchStatus: (expect) => fetchStatus(expect),
    clock: { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    say,
    newId: () => `${new Date().toISOString()}-${randomBytes(2).toString("hex")}`,
    ...(dex !== undefined ? { dex } : {}),
  };
}

export interface AutoBuybackOptions {
  dryRun: boolean;
  once: boolean;
  /** The runner's own log line: it adds the time and scrubs secrets. */
  emit: (text: string) => void;
}

/**
 * Called once by strats run, for every kind of bot. It does nothing in a dry run, for --once, or when auto-buyback is off.
 * Off a droplet it says so and does nothing: the unattended path exists only where strats deploy put it.
 */
export function startAutoBuyback(session: Session, opts: AutoBuybackOptions): CheckSchedule | undefined {
  const { bot } = session;
  if (opts.dryRun || opts.once || bot.autoBuyback !== true) return undefined;
  const secrets = [...sessionSecrets(session)];
  const say = (text: string): void => opts.emit(`${AUTO_TAG}  ${scrub(text, secrets)}`);
  if (!session.runtime) {
    say("Auto-buyback is on, and it runs only on a droplet. Nothing is paid out by this run. Here, use: strats buyback --execute");
    return undefined;
  }
  try {
    // So the first report already carries what was bought back before this droplet existed.
    const basis = loadBasis(bot.id);
    if (basis) mergeBasisLedger(bot.id, basis);
  } catch {
    // The first check tries again and says what is wrong.
  }
  say(`Auto-buyback is on. The first check is in ${Math.round(AUTO_FIRST_MS / 60_000)} minutes, then once a day. It pays when the buyback share is at least ${usd(AUTO_SETTINGS.minUsd)}.`);
  return scheduleChecks(async () => {
    await runUnattended(session, await dropletPorts(session, say));
  }, say);
}
