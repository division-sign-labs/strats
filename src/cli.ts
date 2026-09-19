#!/usr/bin/env node
// Entry point. Parses argv by hand, dispatches to one command, sets the exit code.
import { UsageError, parseArgs, type Args } from "./args.js";
import { Prompts } from "./setup.js";
import { packageVersion } from "./version.js";

const HELP = `strats: run a TokenStrats strategy from your own wallet.

Quotient decides what to hold and serves it as targets. This program holds the
keys, sizes the positions, and places the orders: one Hyperliquid perp for a
single-asset strategy, Polymarket markets for a theme strategy. Non-custodial:
Quotient never holds a key and nothing it receives feeds a decision.

Usage
  strats init --key qsk_... [--ceiling N] [--id name] [--gateway url] [--force]
      Read the settings, create the wallet and keystore, pin the payout settings.
      A theme key also sets up the Polymarket account and prints the deposit address.
      The key can also come from STRATS_API_KEY or a prompt, which keeps it out of shell history.
  strats fund [--id name] [--dex name]
      Single asset: deposit USDC from Arbitrum into Hyperliquid and approve a trading key.
      Theme: show the deposit address, wait for the credit, verify the trading approvals.
  strats run [--id name] [--dry-run] [--once] [--interval 30] [--no-report] [--force-side long|short|flat]
      The loop. One line per cycle. --dry-run sends nothing. --no-report sends no totals to Quotient.
      --force-side trades a made-up target for testing (single asset only); without --dry-run it also needs --yes-place-a-real-order.
      Refuses to start while the bot is deployed, unless --force.
  strats deploy [--id name] [--region blr1] [--size s-1vcpu-1gb] [--from-tarball] [--dry-run] [-y]
      Put the runner on a DigitalOcean droplet in your own account, as a service that restarts.
      Shows the plan and the monthly cost and asks before creating anything. -y skips the question.
      --dry-run prints the plan and the first-boot script without calling DigitalOcean.
      --from-tarball copies this build to the droplet instead of installing from npm.
  strats logs [--id name] [--lines 50] [--follow]
      The deployed runner's log over ssh, or the local log file when not deployed.
  strats destroy [--id name] [-y]
      Stop the runner and delete the droplet and its firewall. Positions are not touched.
  strats status [--id name]
      Wallet, equity, positions, the current targets, settings, and the deployed runner's last lines.
  strats close [--id name] [--coin COIN]
      Close what the bot holds, after a y/N confirm.
  strats config [show|accept] [--id name]
      Compare the server's settings with the pinned payout settings. accept re-pins them.

Environment
  STRATS_PASSPHRASE     keystore passphrase, for unattended runs
  STRATS_HOME           data directory (default ~/.strats)
  STRATS_GATEWAY_URL    gateway base URL
  STRATS_API_KEY        API key for init
  DIGITALOCEAN_TOKEN    DigitalOcean API token for deploy and destroy
  STRATS_RUNTIME_CREDS  set by strats deploy on the droplet; run uses it instead of a keystore

Exit codes: 0 done, 1 failed, 2 wrong usage.`;


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
    console.log(packageVersion());
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
      case "deploy":
        return await (await import("./commands/deploy.js")).deploy(args, prompts);
      case "destroy":
        return await (await import("./commands/destroy.js")).destroy(args, prompts);
      case "logs":
        return await (await import("./commands/logs.js")).logs(args, prompts);
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
