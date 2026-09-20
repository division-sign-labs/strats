// strats fund: move USDC from Arbitrum into Hyperliquid and approve a trading
// key. It reads the master key, as buyback --execute does, and as deploy does
// only when the creator turned auto-buyback on. Everything it signs
// is signed on this machine by the cassie-core funding flow. strats init runs
// the same code as its funding step. A single-asset bot that also trades markets
// has two funding steps, one per venue; --venue polymarket names the second.
import { UsageError, type Args } from "../args.js";
import { pullRecord, pushBasis, type PullResult, type SyncResult } from "../buyback/droplet.js";
import { fileJournal } from "../buyback/journal.js";
import { fetchTarget } from "../client.js";
import { isFunded } from "../install.js";
import { loadRuntimeState, saveRuntimeState } from "../runtime-state.js";
import type { PolymarketCreds } from "../runtime-creds.js";
import { loadPolymarketCreds, openSession, polymarketSignerRole, requireKeystore, type KeystoreSession } from "../session.js";
import { makeSetupContext, type Prompts } from "../setup.js";
import { isPolymarketBot, isTwoVenueBot, marketsStateScope, saveBot, type BotState } from "../state.js";
import { buildAdapter } from "../venue.js";
import { buildPolymarketAdapter } from "../venue-polymarket.js";

/** A deposit wallet that already holds this much is funded: a resumed setup does not wait for a second deposit. */
const ALREADY_FUNDED_USD = 1;

export interface FundOptions {
  /** True when strats init calls this as its funding step: init says what comes next. */
  chained?: boolean;
  /** A two-venue bot only: which venue to fund. Without it the perp is funded, as for any single-asset bot. */
  venue?: "hyperliquid" | "polymarket";
}

function sayHowToStop(prompts: Prompts, chained: boolean, topUp = false): void {
  const again = chained ? "strats init" : "strats fund";
  prompts.interruptMessage = `Stopped. The wallet and its settings are saved. To continue from this step, run: ${again}`;
  console.log(topUp
    ? "This step waits for the deposit to arrive. Let it finish: a top-up that arrives after you stop is not added to the deposits figure, and would count as profit. If that happens: strats buyback --set-deposits <usd>"
    : `This step waits for the deposit to arrive. To stop and continue later, press Ctrl-C and run ${again} again. The wallet is kept, and a deposit that arrives in the meantime is picked up.`);
  console.log("");
}

/** Show the Polymarket deposit address, wait for the credit, and verify the trading approvals. */
async function fundPolymarket(session: KeystoreSession, prompts: Prompts, opts: FundOptions): Promise<number> {
  const { bot } = session;
  const twoVenue = isTwoVenueBot(bot);
  const scope = marketsStateScope(bot);
  if (!bot.polymarket) {
    console.log("This bot has no Polymarket account yet. Run: strats init");
    return 1;
  }
  console.log("What this does");
  console.log("  1. Shows the address to send USDC to. Polymarket's bridge credits it to the deposit wallet as pUSD.");
  console.log(`  2. Waits for the credit to arrive in the deposit wallet ${bot.polymarket.funder}.`);
  console.log("  3. Checks that the trading approvals are in place, and sets any that are missing. This costs nothing.");
  console.log("");
  let creds: PolymarketCreds | undefined;
  try {
    creds = loadPolymarketCreds(session);
  } catch {
    // The funding flow derives the API credentials itself when the keystore has none yet.
  }
  const adapter = buildPolymarketAdapter(creds);
  const acct = { venue: "polymarket" as const, ...bot.polymarket };
  const read = async (): Promise<number | undefined> => (await adapter.balances(acct).catch(() => []))[0]?.total;
  const before = creds ? await read() : undefined;
  // A setup that was stopped after the deposit arrived must not wait for a second one.
  const fundedBefore = twoVenue ? bot.markets?.fundedAt !== undefined : isFunded(bot);
  const skipDepositWait = !fundedBefore && before !== undefined && before >= ALREADY_FUNDED_USD;
  // A droplet that buys back by itself measures profit from the deposits figure this machine sends it. It is paused before the
  // deposit can arrive, so the new money is never measured as profit, and told the new figure once it is recorded below.
  const tellDroplet = !twoVenue && bot.deployment?.autoBuyback === true;
  if (tellDroplet) {
    const paused = pushBasis(bot, { hold: true });
    if (!paused.ok) {
      console.log(`The droplet's automatic buyback could not be paused (${paused.message}), and a deposit that arrives while it runs would be measured as profit. Nothing was changed. Try again, or turn auto-buyback off and run strats deploy first.`);
      return 1;
    }
    console.log("The droplet's automatic buyback is paused until this deposit is recorded. If you stop before then, it stays paused until strats fund finishes.");
  }
  if (skipDepositWait) console.log(`The deposit wallet already holds ${before!.toFixed(2)} pUSD, so this does not wait for another deposit. It checks the trading approvals.`);
  else sayHowToStop(prompts, opts.chained === true, fundedBefore);
  await adapter.runFundingFlow(makeSetupContext(bot.id, session.keystore, session.passphrase, prompts, { skipDepositWait, masterRole: polymarketSignerRole(bot) }), acct);
  const after = await read();
  if (after !== undefined) {
    // Profit is measured against what was deposited. Polymarket has no deposit history to read, so it is recorded here.
    const state = loadRuntimeState(bot.id, scope);
    const arrived = before !== undefined ? Math.max(0, after - before) : 0;
    if (state.netDepositsUsd === undefined) saveRuntimeState(bot.id, { ...state, netDepositsUsd: after, netDepositsAt: new Date().toISOString() }, scope);
    else if (arrived > 0.01) saveRuntimeState(bot.id, { ...state, netDepositsUsd: state.netDepositsUsd + arrived }, scope);
    console.log(`Deposit wallet balance: ${after.toFixed(2)} pUSD.`);
  }
  if (tellDroplet) {
    const resumed = after !== undefined ? pushBasis(bot) : { ok: false as const, message: "the deposit wallet could not be read, so the deposit was not recorded" };
    console.log(resumed.ok
      ? "The droplet has the new deposits figure, and its automatic buyback is on again."
      : `The droplet's automatic buyback stays paused (${resumed.message}). To send it the deposits figure and resume it: strats buyback --sync`);
  }
  // A two-venue bot records this step on its own, so the perp's funding step is never taken for it.
  session.bot = twoVenue ? { ...bot, markets: { fundedAt: new Date().toISOString() } } : { ...bot, fundedAt: new Date().toISOString() };
  saveBot(session.bot);
  if (twoVenue && bot.deployment && fundedBefore) console.log("The droplet does not learn of this deposit, so the public profit figure counts it as profit. Buybacks are not affected: they are measured on Hyperliquid.");
  if (opts.chained) return 0;
  console.log("");
  if (twoVenue && bot.deployment) console.log("The droplet trades the markets once it has the Polymarket credentials. To send them: strats deploy");
  console.log("Next: strats run --dry-run --once   (shows what it would do, sends nothing)");
  console.log("Then: strats deploy   (or strats run, from a location where Polymarket accepts orders)");
  return 0;
}

export interface FundGuardPorts {
  /** This machine's buyback journal. It throws when the file cannot be read. */
  localJournal(): unknown;
  pause(): SyncResult;
  pull(): PullResult;
  release(): SyncResult;
}

export type FundGuard = { ok: true; held: boolean } | { ok: false; message: string };

/**
 * strats fund deposits the wallet's whole USDC balance and uses the wallet's next nonce. While a buyback is part-way its money is in,
 * or on its way to, that same wallet, so funding is refused: here for any stage and for a record that cannot be read, and on a droplet
 * that buys back by itself, which is paused first so it starts nothing during the wait. `held` means the caller must release the pause.
 */
export function guardPartWayBuyback(bot: Pick<BotState, "deployment">, ports: FundGuardPorts): FundGuard {
  let open = true;
  try {
    open = ports.localJournal() !== null;
  } catch {
    // Unreadable counts as part-way.
  }
  if (open) return { ok: false, message: "A buyback is part-way, and its money is in, or on its way to, this wallet. strats fund would deposit it back into Hyperliquid. Finish it first: strats buyback --execute" };
  if (bot.deployment?.autoBuyback !== true) return { ok: true, held: false };
  const paused = ports.pause();
  if (!paused.ok) return { ok: false, message: `The droplet's automatic buyback could not be paused (${paused.message}), and strats fund would deposit the money of a buyback it has part-way. Nothing was changed. Try again.` };
  const pulled = ports.pull();
  if (pulled.ok && pulled.journal === "none") return { ok: true, held: true };
  const released = ports.release();
  const why = pulled.ok
    ? `The droplet is part-way through a buyback (${pulled.stage ?? "stage unknown"}), and its money is in, or on its way to, this wallet. It continues at its next check. Run strats fund after it finishes.`
    : `The droplet could not be asked whether a buyback is part-way (${pulled.message}). Nothing was changed. Try again.`;
  return { ok: false, message: released.ok ? why : `${why} Its automatic buyback stays paused; to resume it: strats buyback --sync` };
}

export async function fund(args: Args, prompts: Prompts): Promise<number> {
  const venue = args.values.venue;
  if (venue !== undefined && venue !== "hyperliquid" && venue !== "polymarket") throw new UsageError("--venue takes hyperliquid or polymarket.");
  return fundSession(requireKeystore(await openSession(args, prompts), "fund"), args, prompts, venue ? { venue } : {});
}

/** The funding step itself, for a session that is already open. It records the result in the bot file and in `session.bot`. */
export async function fundSession(session: KeystoreSession, args: Args, prompts: Prompts, opts: FundOptions = {}): Promise<number> {
  const { bot } = session;
  if (opts.venue !== undefined && !isTwoVenueBot(bot)) throw new UsageError("--venue applies to a single-asset bot that also trades Polymarket markets. This bot has one venue.");
  if (isPolymarketBot(bot) || opts.venue === "polymarket") return fundPolymarket(session, prompts, opts);

  const guard = guardPartWayBuyback(bot, {
    localJournal: () => fileJournal(bot.id).load(),
    pause: () => pushBasis(bot, { hold: true }),
    pull: () => pullRecord(bot, { moveJournal: false }),
    release: () => pushBasis(bot),
  });
  if (!guard.ok) {
    console.log(guard.message);
    return 1;
  }
  if (!guard.held) return fundHyperliquid(session, args, prompts, opts);
  console.log("The droplet's automatic buyback is paused until this finishes.");
  try {
    return await fundHyperliquid(session, args, prompts, opts);
  } finally {
    const released = pushBasis(session.bot);
    if (!released.ok) console.log(`The droplet's automatic buyback stays paused (${released.message}). To resume it: strats buyback --sync`);
  }
}

async function fundHyperliquid(session: KeystoreSession, args: Args, prompts: Prompts, opts: FundOptions): Promise<number> {
  const { bot } = session;
  // The asset decides the venue account: main-dex coins trade from the main account, HIP-3 coins from their own dex.
  let dex = args.values.dex === "main" ? "" : args.values.dex;
  if (dex === undefined) {
    const target = await fetchTarget(session.gateway);
    if (!target.ok) {
      console.log(`Could not read the target to learn which Hyperliquid dex this asset trades on. ${target.message} Try again shortly, or pass --dex.`);
      return 1;
    }
    dex = target.value.target.dex;
    console.log(`${target.value.target.coin} trades on ${dex ? `the "${dex}" dex` : "the main Hyperliquid dex"}.`);
  }
  if (dex !== "" && !/^[a-z][a-z0-9_-]{0,31}$/.test(dex)) throw new Error(`"${dex}" is not a valid dex name.`);

  const adapter = buildAdapter(dex);
  const acct = { venue: "hyperliquid" as const, masterAddress: bot.masterAddress, ...(bot.agentAddress ? { agentAddress: bot.agentAddress } : {}) };
  const instructions = await adapter.fundingInstructions(acct);

  console.log("What this does");
  console.log(`  1. Waits for USDC on Arbitrum at ${bot.masterAddress}. ${instructions.addresses[0]?.note ?? ""}`);
  console.log("  2. Deposits the wallet's whole USDC balance into Hyperliquid. The wallet needs a little ETH on Arbitrum for gas.");
  console.log("  3. Approves a separate trading key that can place orders but cannot withdraw.");
  if (dex) console.log(`  4. Sets Standard account mode and moves the deposit to the "${dex}" dex.`);
  console.log("You are asked before each transfer.");
  console.log("");
  sayHowToStop(prompts, opts.chained === true);

  const ctx = makeSetupContext(bot.id, session.keystore, session.passphrase, prompts);
  const updated = await adapter.runFundingFlow(ctx, acct);
  if (updated.venue !== "hyperliquid" || !updated.agentAddress) throw new Error("The funding flow finished without an approved trading key.");
  // The flow returns a new account; losing it would lose the approved agent address.
  session.bot = { ...bot, agentAddress: updated.agentAddress, fundedAt: new Date().toISOString() };
  saveBot(session.bot);
  console.log(`Trading key approved: ${updated.agentAddress}`);

  const scope = await adapter.portfolioScope(acct);
  if (scope.accountMode !== "disabled") {
    console.log(`The Hyperliquid account mode is "${scope.accountMode}". Positions can only be opened in Standard mode, and this release cannot set it for the main dex. See "Account mode" in the README.`);
  }
  if (opts.chained) return 0;
  console.log("");
  if (isTwoVenueBot(bot) && bot.markets?.fundedAt === undefined) console.log("Polymarket is not funded yet, so the bot trades the perp only. To fund it: strats fund --venue polymarket");
  console.log("Next: strats run --dry-run --once   (shows what it would do, sends nothing)");
  console.log("Then: strats deploy   (or strats run, to run it on this machine)");
  return 0;
}
