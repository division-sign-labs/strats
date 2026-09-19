#!/usr/bin/env node
// Entry point. Parses argv by hand, dispatches to one command, sets the exit code.
import { readFileSync } from "node:fs";
import { UsageError, parseArgs, type Args } from "./args.js";
import { Prompts } from "./setup.js";

const HELP = `strats: run a TokenStrats strategy from your own wallet.

Quotient decides what to hold and serves it as a target. This program holds the
keys, sizes the position, and places the orders on Hyperliquid. Non-custodial:
the keys never leave this machine, and nothing about the account is sent to Quotient.

Usage
  strats init --key qsk_... [--ceiling N] [--id name] [--gateway url] [--force]
      Read the settings, create the wallet and keystore, pin the payout settings.
      The key can also come from STRATS_API_KEY or a prompt, which keeps it out of shell history.
  strats fund [--id name] [--dex name]
      Deposit USDC from Arbitrum into Hyperliquid and approve a trading key.
  strats run [--id name] [--dry-run] [--once] [--interval 30] [--force-side long|short|flat]
      The loop. One line per cycle. --dry-run signs and sends nothing.
      --force-side trades a made-up target for testing; without --dry-run it also needs --yes-place-a-real-order.
  strats status [--id name]
      Wallet, equity, position, stop and target orders, the current target, settings.
  strats close [--id name] [--coin COIN]
      Cancel our stop and target and close the position, after a y/N confirm.
  strats config [show|accept] [--id name]
      Compare the server's settings with the pinned payout settings. accept re-pins them.

Environment
  STRATS_PASSPHRASE    keystore passphrase, for unattended runs
  STRATS_HOME          data directory (default ~/.strats)
  STRATS_GATEWAY_URL   gateway base URL
  STRATS_API_KEY       API key for init

Exit codes: 0 done, 1 failed, 2 wrong usage.`;

function version(): string {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
  return manifest.version ?? "unknown";
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Run strats --help for usage.");
    return 2;
  }
  if (args.flags.has("version")) {
    console.log(version());
    return 0;
  }
  if (args.flags.has("help") || args.command === "" || args.command === "help") {
    console.log(HELP);
    return 0;
  }

  const prompts = new Prompts();
  try {
    // Commands load lazily so --help never pays for the venue SDK.
    switch (args.command) {
      case "init":
        return await (await import("./commands/init.js")).init(args, prompts);
      case "fund":
        return await (await import("./commands/fund.js")).fund(args, prompts);
      case "run":
        return await (await import("./commands/run.js")).run(args, prompts);
      case "status":
        return await (await import("./commands/status.js")).status(args, prompts);
      case "close":
        return await (await import("./commands/close.js")).close(args, prompts);
      case "config":
        return await (await import("./commands/config.js")).config(args, prompts);
      default:
        console.error(`Unknown command "${args.command}". Run strats --help for usage.`);
        return 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof UsageError ? 2 : 1;
  } finally {
    prompts.close();
  }
}

// The venue SDK keeps sockets alive, so exit explicitly once the command is done.
main().then((code) => process.exit(code));
