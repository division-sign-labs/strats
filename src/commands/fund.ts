// strats fund: move USDC from Arbitrum into Hyperliquid and approve a trading
// key. This is the only command that reads the master key. Everything it signs
// is signed on this machine by the cassie-core funding flow.
import type { Args } from "../args.js";
import { fetchTarget } from "../client.js";
import { openSession } from "../session.js";
import { makeSetupContext, type Prompts } from "../setup.js";
import { saveBot } from "../state.js";
import { buildAdapter } from "../venue.js";

export async function fund(args: Args, prompts: Prompts): Promise<number> {
  const session = await openSession(args, prompts);
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

  const ctx = makeSetupContext(bot.id, session.keystore, session.passphrase, prompts);
  const updated = await adapter.runFundingFlow(ctx, acct);
  if (updated.venue !== "hyperliquid" || !updated.agentAddress) throw new Error("The funding flow finished without an approved trading key.");
  // The flow returns a new account; losing it would lose the approved agent address.
  saveBot({ ...bot, agentAddress: updated.agentAddress });
  console.log(`Trading key approved: ${updated.agentAddress}`);

  const scope = await adapter.portfolioScope(acct);
  if (scope.accountMode !== "disabled") {
    console.log(`The Hyperliquid account mode is "${scope.accountMode}". Positions can only be opened in Standard mode, and this release cannot set it for the main dex. See "Account mode" in the README.`);
  }
  console.log("");
  console.log("Next: strats run --dry-run --once   (shows what it would do, sends nothing)");
  console.log("Then: strats run");
  return 0;
}
