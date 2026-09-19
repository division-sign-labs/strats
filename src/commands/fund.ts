// strats fund: move USDC from Arbitrum into Hyperliquid and approve a trading
// key. This is the only command that reads the master key. Everything it signs
// is signed on this machine by the cassie-core funding flow. strats init runs
// the same code as its funding step. A single-asset bot that also trades markets
// has two funding steps, one per venue; --venue polymarket names the second.
import { UsageError, type Args } from "../args.js";
import { fetchTarget } from "../client.js";
import { isFunded } from "../install.js";
import { loadRuntimeState, saveRuntimeState } from "../runtime-state.js";
import type { PolymarketCreds } from "../runtime-creds.js";
import { loadPolymarketCreds, openSession, polymarketSignerRole, requireKeystore, type KeystoreSession } from "../session.js";
import { makeSetupContext, type Prompts } from "../setup.js";
import { isPolymarketBot, isTwoVenueBot, marketsStateScope, saveBot } from "../state.js";
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

function sayHowToStop(prompts: Prompts, chained: boolean): void {
  const again = chained ? "strats init" : "strats fund";
  prompts.interruptMessage = `Stopped. The wallet and its settings are saved. To continue from this step, run: ${again}`;
  console.log(`This step waits for the deposit to arrive. To stop and continue later, press Ctrl-C and run ${again} again. The wallet is kept, and a deposit that arrives in the meantime is picked up.`);
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
  if (skipDepositWait) console.log(`The deposit wallet already holds ${before!.toFixed(2)} pUSD, so this does not wait for another deposit. It checks the trading approvals.`);
  else sayHowToStop(prompts, opts.chained === true);
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
  // A two-venue bot records this step on its own, so the perp's funding step is never taken for it.
  session.bot = twoVenue ? { ...bot, markets: { fundedAt: new Date().toISOString() } } : { ...bot, fundedAt: new Date().toISOString() };
  saveBot(session.bot);
  if (opts.chained) return 0;
  console.log("");
  if (twoVenue && bot.deployment) console.log("The droplet trades the markets once it has the Polymarket credentials. To send them: strats deploy");
  console.log("Next: strats run --dry-run --once   (shows what it would do, sends nothing)");
  console.log("Then: strats deploy   (or strats run, from a location where Polymarket accepts orders)");
  return 0;
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
