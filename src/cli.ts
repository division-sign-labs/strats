#!/usr/bin/env node
// Entry point. Parses argv by hand, dispatches to one command, sets the exit code.
import { UsageError, parseArgs, type Args } from "./args.js";
import { Prompts } from "./setup.js";
import { packageVersion } from "./version.js";

const HELP = `strats: run a TokenStrats strategy from your own wallet.

Quotient decides what to hold and serves it as targets. This program holds the
keys, sizes the positions, and places the orders: one Hyperliquid perp for a
single-asset strategy, plus the asset's Polymarket markets when the settings list
any; Polymarket markets for a theme strategy; and a team's games on Polymarket
for a team strategy. One key is one bot. Non-custodial: Quotient never holds a
key and nothing it receives feeds a decision.

Usage
  strats init --key qsk_... [--ceiling N] [--id name] [--gateway url] [--no-deploy] [--perp-only] [--region blr1] [-y] [--force]
      The whole install. Read the settings, create the wallet and keystore, pin the payout settings,
      show the address to fund and wait for the deposit, then deploy the runner to a droplet (blr1, Bangalore).
      A theme or team key also sets up the Polymarket account. Asks once whether to publish the wallet address; the default is no.
      A single-asset key with Polymarket markets is still one bot: init sets up Hyperliquid and the Polymarket account, funds the
      perp, then funds Polymarket. That last step can be skipped, at its question or with --perp-only, to start with the perp only.
      Stop at any point with Ctrl-C and run strats init again: it continues where it stopped and keeps the wallet.
      --no-deploy stops after funding; strats run then runs the bot on this machine. -y accepts the deploy question.
      --region, --size and --from-tarball apply to the deploy step, as in strats deploy.
      --force reads the settings again and replaces them; the wallet is kept.
      The key can also come from STRATS_API_KEY or a prompt, which keeps it out of shell history.
  strats fund [--id name] [--dex name] [--venue hyperliquid|polymarket]
      The funding step of init, on its own, and the way to add funds later.
      Single asset: deposit USDC from Arbitrum into Hyperliquid and approve a trading key.
      Theme and team: show the deposit address, wait for the credit, verify the trading approvals.
      Single asset with markets: --venue polymarket funds the Polymarket side; without it the perp is funded.
  strats run [--id name] [--dry-run] [--once] [--interval 30] [--no-report] [--force-side long|short|flat]
      The loop. One line per cycle. --dry-run sends nothing. --no-report sends no report to Quotient.
      Single asset with markets: the perp loop and the markets loop run side by side, and neither waits for or stops the other.
      --force-side trades a made-up target for testing (single asset only); without --dry-run it also needs --yes-place-a-real-order.
      Refuses to start while the bot is deployed, unless --force.
  strats deploy [--id name] [--region blr1] [--size s-1vcpu-1gb] [--from-tarball] [--dry-run] [-y]
      The deploy step of init, on its own, and the way to update a droplet.
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
  strats close [--id name] [--coin COIN] [--venue polymarket]
      Close what the bot holds, after a y/N confirm. Single asset with markets: the perp, or with --venue polymarket the markets.
  strats buyback [--id name] [--execute] [--min-usd 25] [--slippage 1] [--max-impact 3] [--dex name]
      Split the bot's profit as pinned on this machine, withdraw the buyback share to the bot's own wallet, and swap it
      for your token through LI.FI. Without --execute it is a dry run: it reads everything, fetches a live quote, prints
      the whole plan, and signs and sends nothing. --execute shows the same plan and always asks y/N; -y does not skip it.
      A run that stops part-way is continued by running it again. It never pays the same profit twice.
      Runs on this machine only, never on the droplet. Tokens on Ethereum, Base and Arbitrum.
      --min-usd (at least 10) is the smallest withdrawal worth the fees. --slippage (at most 5) and --max-impact
      (at most 10) are percents. --dex names the Hyperliquid dex to take the money from; main is the main dex.
  strats buyback --to <0x address | wallet> [--id name]
      Pin the address the bought token goes to, after a y/N confirm. wallet means this bot's own wallet, the default.
  strats buyback --set-deposits <usd> [--id name]
      Polymarket bots: record everything ever deposited, on a machine that has no record. Profit is measured from it.
  strats buyback --sync [--id name]
      Send the droplet the buyback totals its public report shows. Nothing else is sent.
  strats config [show|accept] [--id name]
      Compare the server's settings with the pinned payout settings. accept re-pins them.
  strats config publish-wallet [on|off] [--id name]
      Show or change whether reports carry the wallet address, which lets the public project page show it. Off by default.

Environment
  STRATS_PASSPHRASE     keystore passphrase, for unattended runs
  STRATS_HOME           data directory (default ~/.strats)
  STRATS_GATEWAY_URL    gateway base URL
  STRATS_API_KEY        API key for init
  DIGITALOCEAN_TOKEN    DigitalOcean API token for init, deploy and destroy
  STRATS_RUNTIME_CREDS  set by strats deploy on the droplet; run uses it instead of a keystore
  STRATS_RPC_ARBITRUM   Arbitrum RPC for buyback (default https://arb1.arbitrum.io/rpc)
  STRATS_RPC_POLYGON    Polygon RPC for buyback (default https://polygon.drpc.org)

Exit codes: 0 done, 1 failed, 2 wrong usage, 3 stopped part-way; run it again, 130 stopped with Ctrl-C at a prompt or a wait.`;


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
      case "buyback":
        return await (await import("./commands/buyback.js")).buyback(args, prompts);
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
