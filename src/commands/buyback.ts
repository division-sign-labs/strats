// strats buyback: take the bot's profit, split it as pinned on this machine,
// withdraw the buyback share to the bot's own wallet, and swap it for the
// creator's token. The default is a dry run that signs and sends nothing.
//
// Every input that decides where money goes is local: the token, the split and
// the destination come from the bot file, and the withdrawal always goes to the
// bot's own wallet. The one read from Quotient is the target of a single-asset
// bot, and only to learn which Hyperliquid dex the money comes FROM. This
// command never runs on a droplet. A droplet buys back by itself only when the
// creator turned auto-buyback on (src/buyback/auto.ts), and while it does,
// --execute is refused here, so the same profit is never paid from two places.
import { randomBytes } from "node:crypto";
import { KeyRoles } from "@quotient-forecasting/cassie-core";
import { isAddress } from "viem";
import { UsageError, type Args } from "../args.js";
import { SOURCE_CHAINS, chainWallet, checkGas, type GasCheck } from "../buyback/chain.js";
import { pullRecord, pushBasis } from "../buyback/droplet.js";
import { fileJournal, type Journal } from "../buyback/journal.js";
import { checkQuote, fetchQuote, fetchStatus, floorFrom, type QuoteExpectation } from "../buyback/lifi.js";
import { moneyText, resumePayout, startPayout, type BuybackDeps, type Outcome } from "../buyback/machine.js";
import { MAX_IMPACT_DEFAULT, MIN_USD_DEFAULT, MIN_USD_FLOOR, SLIPPAGE_DEFAULT, planBuyback, refusalText } from "../buyback/plan.js";
import { CONFIRM_QUESTION, DRY_RUN_FOOTER, SUPPORTED_TOKEN_CHAINS, chainLabel, renderConfirmation, renderHeader, renderProfit, renderQuote, renderRoute, renderSplit, type RouteContext } from "../buyback/text.js";
import { BuybackRefusal, hyperliquidVenue, polymarketVenue, type BuybackVenuePort } from "../buyback/venues.js";
import { fetchTarget } from "../client.js";
import { payoutsLedgerFile } from "../paths.js";
import { PUSH_FAILED_TEXT, appendLedger, pushPayoutSummary, readLedger, summarize, writePayoutSummary } from "../payouts.js";
import { usd } from "../reconcile.js";
import { loadRuntimeState, saveRuntimeState } from "../runtime-state.js";
import { loadPolymarketCreds, openSession, requireKeystore, runtimeCredsPresent, scrub, sessionSecrets, type KeystoreSession } from "../session.js";
import { readSecret, type Prompts } from "../setup.js";
import { dropletBuysBack, isPolymarketBot, loadBot, resolveBotId, saveBot, type BotState } from "../state.js";

function percentFlag(raw: string | undefined, name: string, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > max) throw new UsageError(`--${name} is a percent above 0 and at most ${max}.`);
  return value;
}

function minUsdFlag(raw: string | undefined): number {
  if (raw === undefined) return MIN_USD_DEFAULT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < MIN_USD_FLOOR) throw new UsageError(`--min-usd is in dollars, at least ${MIN_USD_FLOOR}.`);
  return value;
}

/** The question is always put to a person. No flag answers it. */
async function askGoAhead(prompts: Prompts, question: string): Promise<boolean> {
  const answer = (await prompts.ask(question)).toLowerCase();
  return answer === "y" || answer === "yes";
}

/** The one sentence strats buyback --execute says instead of paying, while a droplet may be paying out the same profit. Null when it may go ahead. */
export function executeRefusal(bot: Pick<BotState, "autoBuyback" | "deployment">): string | null {
  return dropletBuysBack(bot)
    ? "The droplet does the buybacks for this bot, so nothing is paid from here; to do one by hand, turn auto-buyback off (strats config auto-buyback off) and run strats deploy."
    : null;
}

/** strats buyback --sync: send the droplet the payout totals its report shows. Nothing else. */
function sync(bot: BotState): number {
  if (bot.deployment?.autoBuyback === true) {
    // This droplet keeps its own totals. What it takes from here is what it measures profit from: the deposits figure and this machine's payout record.
    const sent = pushBasis(bot);
    console.log(sent.ok
      ? `The droplet ${bot.deployment.host} now has this machine's deposits figure and payout record. Its automatic buyback measures profit from them.`
      : `The droplet could not be reached (${sent.message}). To try again: strats buyback --sync`);
    return sent.ok ? 0 : 1;
  }
  writePayoutSummary(bot.id);
  const result = pushPayoutSummary(bot);
  if (result.pushed) console.log(`The droplet ${bot.deployment!.host} now has this bot's buyback totals. Its next report shows them.`);
  else if (result.reason === "not-deployed") console.log("This bot is not deployed, so there is no droplet to tell. The report of strats run reads the totals from this machine.");
  else console.log(`The droplet could not be reached (${result.message}). To try again: strats buyback --sync`);
  return result.pushed || result.reason === "not-deployed" ? 0 : 1;
}

/** strats buyback --to: pin, or clear, the address the bought token goes to. */
async function pinDestination(session: KeystoreSession, prompts: Prompts, raw: string): Promise<number> {
  const { bot } = session;
  const clear = raw === "wallet";
  if (!clear && (!isAddress(raw) || /^0x0{40}$/i.test(raw))) throw new UsageError("--to takes a 0x address, or the word wallet for this bot's own wallet. A mixed-case address must have a valid checksum.");
  const before = bot.pinned.destination;
  if (clear ? before === undefined : before?.toLowerCase() === raw.toLowerCase()) {
    console.log(`Nothing was changed. The bought token already goes to ${before ?? `this bot's own wallet ${bot.masterAddress}`}.`);
    return 0;
  }
  console.log(`The bought token now goes to  ${before ?? `${bot.masterAddress} (this bot's own wallet)`}`);
  console.log(`It would go to                ${clear ? `${bot.masterAddress} (this bot's own wallet)` : raw}`);
  console.log(`on ${chainLabel(bot.pinned.token.chainId)}. Only a wallet you control there can use the token. A wrong address cannot be undone.`);
  if (!(await askGoAhead(prompts, "Pin this destination? (y/N)"))) {
    console.log("Nothing was changed.");
    return 0;
  }
  const { destination: _old, ...rest } = bot.pinned;
  saveBot({ ...bot, pinned: clear ? rest : { ...rest, destination: raw } });
  console.log(clear ? "Cleared. The bought token goes to this bot's own wallet." : `Pinned. The bought token goes to ${raw}.`);
  return 0;
}

/** strats buyback --set-deposits: record what was deposited, for a machine that has no record. */
async function setDeposits(session: KeystoreSession, prompts: Prompts, raw: string): Promise<number> {
  const { bot } = session;
  if (!isPolymarketBot(bot)) throw new UsageError("--set-deposits applies to Polymarket bots. A single-asset bot's deposits are read from Hyperliquid's own history.");
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new UsageError("--set-deposits takes a dollar amount, 0 or more.");
  const state = loadRuntimeState(bot.id);
  console.log(`Deposits recorded on this machine  ${state.netDepositsUsd === undefined ? "none" : usd(state.netDepositsUsd)}`);
  console.log(`New figure                         ${usd(value)}, as everything ever deposited into this bot's Polymarket wallet`);
  console.log("Profit is the wallet's value less this figure, less what buybacks have withdrawn. A figure that is too low pays out deposits as if they were profit.");
  if (!(await askGoAhead(prompts, "Record it? (y/N)"))) {
    console.log("Nothing was changed.");
    return 0;
  }
  // The beginning of time: every withdrawal in the payout record is subtracted from this figure.
  saveRuntimeState(bot.id, { ...state, netDepositsUsd: value, netDepositsAt: new Date(0).toISOString() });
  console.log(`Recorded. To see what a buyback would do now: strats buyback${bot.deployment ? "\nThe droplet keeps its own deposits figure for the public report. This changes only what strats buyback measures profit from." : ""}`);
  if (bot.deployment?.autoBuyback === true) {
    const sent = pushBasis(bot);
    console.log(sent.ok ? "The droplet's automatic buyback measures profit from the new figure too." : `The droplet's automatic buyback still uses the old figure: it could not be reached (${sent.message}). To send it: strats buyback --sync`);
  }
  return 0;
}

interface Setup {
  venue: BuybackVenuePort;
  dex: string | undefined;
}

/** A single-asset bot's money sits in the dex its asset trades on. That is the one thing read from Quotient, and --dex replaces it. */
async function chooseVenue(session: KeystoreSession, args: Args, prompts: Prompts, journal: Journal | null): Promise<Setup | number> {
  if (isPolymarketBot(session.bot)) {
    if (args.values.dex !== undefined) throw new UsageError("--dex applies to single-asset bots only.");
    return { venue: polymarketVenue(session, prompts), dex: undefined };
  }
  let dex = journal?.dex ?? (args.values.dex === "main" ? "" : args.values.dex);
  if (dex === undefined) {
    const target = await fetchTarget(session.gateway);
    if (!target.ok) {
      console.log(`Could not read the target to learn which Hyperliquid dex this asset trades on. ${target.message} Try again shortly, or pass --dex.`);
      return 1;
    }
    dex = target.value.target.dex;
  }
  if (dex !== "" && !/^[a-z][a-z0-9_-]{0,31}$/.test(dex)) throw new Error(`"${dex}" is not a valid dex name.`);
  return { venue: hyperliquidVenue(session, dex, prompts), dex };
}

export async function buyback(args: Args, prompts: Prompts): Promise<number> {
  if (runtimeCredsPresent()) throw new Error("strats buyback runs on your own machine, not on the droplet.");
  const execute = args.flags.has("execute");
  const modes = [args.flags.has("sync"), args.values["set-deposits"] !== undefined, args.values.to !== undefined, execute].filter(Boolean).length;
  if (modes > 1) throw new UsageError("Use one of --execute, --sync, --set-deposits or --to at a time.");
  if (args.flags.has("dry-run")) throw new UsageError("strats buyback is a dry run unless --execute is given.");
  const minUsd = minUsdFlag(args.values["min-usd"]);
  const slippagePct = percentFlag(args.values.slippage, "slippage", SLIPPAGE_DEFAULT, 5);
  const maxImpactPct = percentFlag(args.values["max-impact"], "max-impact", MAX_IMPACT_DEFAULT, 10);
  if (execute && !prompts.interactive) throw new UsageError("strats buyback --execute asks a question and needs a terminal.");
  if (execute) {
    // Decided from the bot file alone, before the keystore is opened or anything is read.
    const refusal = executeRefusal(loadBot(resolveBotId(args.values.id)));
    if (refusal) {
      console.log(refusal);
      return 1;
    }
  }

  if (args.flags.has("sync")) return sync(loadBot(resolveBotId(args.values.id)));
  const session = requireKeystore(await openSession(args, prompts), "buyback");
  if (args.values.to !== undefined) return pinDestination(session, prompts, args.values.to);
  if (args.values["set-deposits"] !== undefined) return setDeposits(session, prompts, args.values["set-deposits"]);

  const { bot } = session;
  const venueName = isPolymarketBot(bot) ? "polymarket" : "hyperliquid";
  const source = SOURCE_CHAINS[venueName];
  const secrets: Array<string | undefined> = [...sessionSecrets(session)];
  const print = (text: string): void => console.log(scrub(text, secrets));
  prompts.interruptMessage = "Stopped. To continue, run: strats buyback --execute. It picks up from what was recorded and never sends a payment twice.";

  if (bot.deployment?.autoBuyback === true) {
    // A dry run beside a droplet that buys back by itself: its payout lines are copied here first, so "Already split" is true.
    const pulled = pullRecord(bot, { moveJournal: false });
    if (!pulled.ok) print(`The droplet's payout record could not be read (${pulled.message}), so "Already split" below may be out of date.`);
    else if (pulled.journal === "left") print(`The droplet is part-way through a buyback (${pulled.stage}). It continues it at its next check.`);
  }

  const store = fileJournal(bot.id);
  let journal = store.load();
  if (journal && !execute) {
    print(`A buyback started ${journal.startedAt} is not finished.`);
    print(describeWhere(journal, bot, source));
    print("Nothing new is planned while it is open. To continue it: strats buyback --execute");
    return 0;
  }

  const token = journal?.token ?? bot.pinned.token;
  if (!(SUPPORTED_TOKEN_CHAINS as readonly number[]).includes(token.chainId)) {
    print(`The pinned token is on ${chainLabel(token.chainId)}. Buybacks work for tokens on Ethereum, Base and Arbitrum.`);
    return 1;
  }
  if (bot.pinned.split.buybackPct + bot.pinned.split.keepPct !== 100) {
    print("The pinned split does not add up to 100%. See it with: strats config show");
    return 1;
  }

  const setup = await chooseVenue(session, args, prompts, journal);
  if (typeof setup === "number") return setup;
  const { venue, dex } = setup;
  const destination = journal?.destination ?? bot.pinned.destination ?? bot.masterAddress;

  // The wallet key is read only when something will be signed. A Polymarket bot's reads already need it, as in strats status.
  let signerPk: string | undefined;
  if (execute) {
    signerPk = readSecret(session.keystore, bot.id, KeyRoles.master, session.passphrase) ?? undefined;
    if (!signerPk) throw new Error("The keystore has no wallet key.");
    secrets.push(signerPk);
  }
  if (venueName === "polymarket") {
    const creds = loadPolymarketCreds(session);
    secrets.push(creds.signerPk, creds.l2.secret, creds.l2.passphrase, creds.l2.apiKey);
  }
  const wallet = chainWallet(venueName, bot.masterAddress, signerPk);

  const ctx: RouteContext = {
    botId: bot.id, venueLabel: venueName === "hyperliquid" ? "Hyperliquid" : "Polymarket",
    sourceSymbol: source.symbol, sourceChain: source.chainName, sourceChainId: source.chainId, nativeSymbol: source.nativeSymbol,
    walletAddress: bot.masterAddress, token, destination, destinationIsWallet: destination.toLowerCase() === bot.masterAddress.toLowerCase(),
    split: bot.pinned.split, earlierBuybacks: 0, slippagePct, maxImpactPct,
  };
  const expectation = (amount: bigint, floorMinOut?: bigint): QuoteExpectation => ({
    fromChainId: source.chainId, toChainId: token.chainId, fromToken: source.token, toToken: token.address, fromAmount: amount,
    fromAddress: bot.masterAddress, toAddress: destination, slippagePct, maxImpactPct, ...(floorMinOut !== undefined ? { floorMinOut } : {}),
  });
  const noRoute = (text: string): string => (venueName === "polymarket"
    ? `${text} Polymarket pays out in pUSD, and this release swaps it only through LI.FI. Nothing else is tried.`
    : text);

  const deps = (j: Pick<Journal, "withdrawUsd" | "feeUsd" | "arriveUnits"> | null): BuybackDeps => ({
    venue, wallet,
    lifi: {
      async quote(amount, floorMinOut) {
        const fetched = await fetchQuote(expectation(amount));
        if (!fetched.ok) return { ok: false, reasons: [noRoute(fetched.message)] };
        const failures = checkQuote(fetched.quote, expectation(amount, floorMinOut));
        return failures.length === 0 ? { ok: true, quote: fetched.quote } : { ok: false, reasons: failures };
      },
      status: (txHash) => fetchStatus({ txHash, fromChainId: source.chainId, toChainId: token.chainId, toToken: token.address, toAddress: destination }),
    },
    clock: { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    journal: store,
    ledger: {
      has: (type, id) => readLedger(bot.id).lines.some((l) => l.type === type && l.id === id),
      append: (entry) => void appendLedger(bot.id, entry),
    },
    sync: () => {
      const pushed = pushPayoutSummary(loadBot(bot.id));
      if (!pushed.pushed && pushed.reason === "failed") print(PUSH_FAILED_TEXT);
    },
    print,
    progress: (text) => void process.stdout.write(text),
    confirm: () => askGoAhead(prompts, CONFIRM_QUESTION),
    // A resumed run: the withdrawal is already in the wallet, so only the swap is shown and asked about.
    describeQuote: (quote) => {
      const amounts = { withdrawUsd: j?.withdrawUsd ?? 0, feeUsd: j?.feeUsd ?? 0, arriveUsd: Number(BigInt(j?.arriveUnits ?? "0")) / 1e6 };
      return ["", ...renderRoute(amounts, quote, ctx, false), ...renderQuote({ feeUsd: 0 }, quote, ctx, null, new Date()), ...renderConfirmation(amounts, quote, ctx, floorFrom(quote), false)];
    },
    tokenChainName: chainLabel(token.chainId),
  });

  /** Once money may have moved, a crash must not read as "nothing happened". */
  const guarded = async (run: () => Promise<Outcome>): Promise<Outcome> => {
    try {
      return await run();
    } catch (error) {
      if (store.load() === null) throw error;
      print(`Stopped: ${error instanceof Error ? error.message : String(error)}`);
      print("What was done is recorded. Run strats buyback --execute again: it continues from there and never sends a payment twice.");
      return { code: 3 };
    }
  };

  if (journal) {
    const open = journal;
    const outcome = await guarded(() => resumePayout(deps(open), open));
    if (outcome.code !== "replan") return outcome.code;
    // Nothing was sent, so the plan is made again from what is pinned now.
    const pinnedNow = bot.pinned.destination ?? bot.masterAddress;
    if (open.token.chainId !== bot.pinned.token.chainId || open.token.address.toLowerCase() !== bot.pinned.token.address.toLowerCase() || open.destination.toLowerCase() !== pinnedNow.toLowerCase()) {
      print("The pinned token or destination changed since then. Run strats buyback --execute again to plan with the current ones.");
      return 1;
    }
    journal = null;
  }

  // A new payout.
  const ledger = readLedger(bot.id);
  const payouts = summarize(ledger.lines);
  ctx.earlierBuybacks = payouts.withdrawals.length;
  let figures;
  try {
    figures = await venue.figures(payouts);
  } catch (error) {
    if (!(error instanceof BuybackRefusal)) throw error;
    print(error.message);
    return 1;
  }
  const plan = planBuyback({ venue: venueName, ...figures, settledUsd: payouts.settledUsd, buybackPct: bot.pinned.split.buybackPct, minUsd });
  for (const text of [...renderHeader(bot.id, !execute), ...renderProfit(plan, ctx)]) print(text);
  if (ledger.skipped > 0) {
    print(`Warning: ${ledger.skipped} line${ledger.skipped === 1 ? "" : "s"} of the payout record ${payoutsLedgerFile(bot.id)} could not be read and ${ledger.skipped === 1 ? "is" : "are"} not counted above. If a buyback is missing from "Already split", the same profit would be paid again.`);
    if (execute) {
      print("Nothing is paid while the record cannot be read in full. Repair or remove the damaged line yourself, then run this again.");
      return 1;
    }
  }
  const refusal = refusalText(plan, usd);
  if (refusal) {
    print(refusal);
    return execute ? 1 : 0;
  }

  const fetched = await fetchQuote(expectation(plan.arriveUnits));
  if (!fetched.ok) {
    for (const text of renderSplit(plan, ctx)) print(text);
    print(noRoute(fetched.message));
    print("Nothing was sent.");
    return 1;
  }
  const { quote } = fetched;
  const failures = checkQuote(quote, expectation(plan.arriveUnits));
  let gas: GasCheck | null = null;
  let gasProblem = "";
  try {
    gas = await checkGas(wallet, quote, plan.arriveUnits);
  } catch (error) {
    gasProblem = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 160) : "unknown error";
  }
  for (const text of [...renderSplit(plan, ctx), ...renderRoute(plan, quote, ctx), ...renderQuote(plan, quote, ctx, gas, new Date())]) print(text);
  if (!gas) print(`The wallet's gas on ${source.chainName} could not be read (${gasProblem}). Set ${source.rpcEnv} to another RPC if this keeps happening.`);
  if (failures.length > 0) {
    print(`The quote was refused: ${failures.join("; ")}.`);
    print("Nothing was sent.");
    return 1;
  }
  if (!execute) {
    print(bot.deployment?.autoBuyback === true ? "Nothing was sent. The droplet carries this out by itself at its next daily check."
      : dropletBuysBack(bot) ? "Nothing was sent. Auto-buyback is on, and the droplet learns of it at the next: strats deploy" : DRY_RUN_FOOTER);
    return 0;
  }
  if (!gas) {
    print("Nothing was sent: money does not leave the venue until the wallet is known to hold gas for the swap.");
    return 1;
  }
  if (!gas.enough) {
    print(`Nothing was sent. The wallet needs gas before money leaves ${ctx.venueLabel}: send about ${gas.shortfallText} ${source.nativeSymbol} on ${source.chainName} to ${bot.masterAddress}, then run this again.`);
    return 1;
  }

  const floorMinOut = floorFrom(quote);
  for (const text of renderConfirmation(plan, quote, ctx, floorMinOut)) print(text);
  if (!(await askGoAhead(prompts, CONFIRM_QUESTION))) {
    print("Nothing was changed.");
    return 0;
  }
  const id = `${new Date().toISOString()}-${randomBytes(2).toString("hex")}`;
  const outcome = await guarded(() => startPayout(deps({ withdrawUsd: plan.withdrawUsd, feeUsd: plan.feeUsd, arriveUnits: plan.arriveUnits.toString() }), {
    id, ...(dex !== undefined ? { dex } : {}), withdrawUsd: plan.withdrawUsd, feeUsd: plan.feeUsd, arriveUnits: plan.arriveUnits,
    profitSettledUsd: plan.profitSettledUsd, buybackPct: plan.buybackPct, token, destination, floorMinOut,
    tokenSymbol: quote.action.toToken.symbol, tokenDecimals: quote.action.toToken.decimals,
  }));
  return outcome.code === "replan" ? 1 : outcome.code;
}

/** Where the money of an unfinished buyback is, for a dry run that finds one. */
function describeWhere(journal: Journal, bot: BotState, source: { chainName: string; symbol: string }): string {
  const parts = { wallet: { address: bot.masterAddress, chainName: source.chainName, sourceSymbol: source.symbol } } as Parameters<typeof moneyText.arrived>[0];
  switch (journal.stage) {
    case "confirmed": return "Nothing was sent.";
    case "withdraw_sending": return "A withdrawal may or may not have gone out. The next run checks before doing anything else.";
    case "withdraw_sent": return moneyText.onItsWay(parts, journal);
    case "arrived": case "approve_sending": case "approved": return moneyText.arrived(parts, journal);
    case "swap_sending": return `The swap may or may not have been sent${journal.swap ? ` (transaction ${journal.swap.hash})` : ""}. The next run checks.`;
    case "swap_sent": return moneyText.inFlight(journal.swap?.hash ?? "unknown");
  }
}
