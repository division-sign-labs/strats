# strats

`strats` runs a TokenStrats strategy from your own wallet. Quotient decides what to hold and serves it as declarative targets; this program holds the keys, sizes the positions, and places the orders. It keeps no trading state of its own: every cycle it reads the targets and the venue from scratch and converges, so downtime, restarts and missed updates need no replay.

There are two strategies. The API key you copy from TokenStrats belongs to one of them, and `strats init` works out which.

| Strategy | Venue | What it holds |
|---|---|---|
| Single asset (`stock-ls`) | Hyperliquid | One perpetual, long or short, with a stop and a target resting on the venue |
| Your own theme (`theme`) | Polymarket | Shares in the markets you chose for your theme, each bought once and sold at a take-profit price or when the market closes |

## Install

Node 22 or newer. One command takes you from an API key to a runner that trades unattended:

```
npx @quotient-forecasting/strats init --key qsk_...
```

It works the same way for both strategies, and goes through these steps in order:

1. **Settings.** Reads the settings you saved on TokenStrats and shows them. Asks for your local ceiling, whether to publish the wallet address (the default is no), and a keystore passphrase.
2. **Wallet.** Creates the wallet on this machine and encrypts its keys. For a theme key it also creates the Polymarket account the wallet trades from, which costs nothing.
3. **Funding.** Shows the address and what to send, waits for the deposit, and moves it into the venue. You are asked before each transfer.
4. **Deploy.** Puts the runner on a DigitalOcean droplet in your own account, in region `blr1` (Bangalore). It shows the plan, the monthly cost and exactly what will be sent to the droplet, and asks before creating anything.
5. **Watching it.** Prints how to follow the bot: `strats status`, `strats logs`, and the public project page at https://tokenstrats.xyz/projects.

You can stop at any step, including the wait for the deposit, with Ctrl-C. Run `strats init` again and it continues from the first step that is not finished. It does not need the key again, and it never creates a second wallet. `strats fund` and `strats deploy` are the same two steps as commands of their own: use them to add funds later, or to update the droplet.

The deploy step needs a DigitalOcean API token. If you have never made one: create a token with read and write scope at https://cloud.digitalocean.com/account/api/tokens. Paste it when `init` asks (it is not shown, and is saved to `~/.strats/digitalocean.token` with owner-only permissions), or set `DIGITALOCEAN_TOKEN` before you run the command.

Flags for the deploy step:

| Flag | Effect |
|---|---|
| `--no-deploy` | Stop after funding. `strats run` then runs the bot on this machine, and `strats deploy` puts it on a droplet later. |
| `--region slug` | A DigitalOcean region other than `blr1`. A theme bot is refused a US region, because Polymarket refuses orders from there. |
| `-y` | Accept the deploy question without being asked. The plan, the cost and what reaches the droplet are still printed first. |

To install it once and type `strats` from then on:

```
npm install -g @quotient-forecasting/strats
```

## Non-custodial, and what leaves the machine

The wallet is created on your machine. Its private keys are encrypted in a local keystore (scrypt + AES-256-GCM, file mode 0600). Quotient never receives a key, cannot move funds, and cannot place orders.

Config and targets come down. One thing goes up: a report of the bot's totals, what it holds and its last trades, described below. It is for display only. Nothing Quotient receives is an input to any decision it makes, and the targets are the same whether or not a report was ever sent.

This is everything the program sends:

| To | What | When |
|---|---|---|
| Quotient gateway | `GET` requests for the config and the targets, with the API key in the `x-quotient-api-key` header. No body. | `init`, `run`, `status`, `config`, `fund`, `close` |
| Quotient gateway | The report: one `POST` at most every 5 minutes, and one soon after an order. See "The report". | `run`, unless `--dry-run` or `--no-report` |
| Hyperliquid API | Read queries keyed by the wallet's public address. Orders, cancels and the leverage setting, signed locally by the trading key. | single-asset bots: `run`, `status`, `close` |
| Hyperliquid API and an Arbitrum RPC | Balance reads, the USDC deposit transaction, the trading-key approval and the account setup, signed locally by the master key. | single-asset bots: the funding step only (`init`, `fund`) |
| Polymarket APIs and a Polygon RPC | Account setup, trading approvals, balance, position and book reads, orders and redemptions, signed locally by the wallet key. One request to `polymarket.com/api/geoblock`. | theme bots: `init`, `fund`, `run`, `status`, `close` |
| DigitalOcean API | Create, read and delete the droplet, its ssh key and its firewall, with your DigitalOcean token. | `init`, `deploy`, `destroy` |
| Your droplet, over ssh | The runner and the credentials it needs. See "What reaches the droplet". | `init`, `deploy`, `status`, `logs`, `destroy` |
| npm registry | One `npm view` to learn whether this version is published. | `init`, `deploy` |

Nothing else. There is no telemetry, no error reporting and no update check. The gateway sees your IP address and the API key, as any web server would.

### The report

After a cycle, at most once every 5 minutes, `run` sends a report to `POST /api/v1/strategies/{id}/reports`. When an order is acknowledged, one report goes out early, so the trade reaches the site without waiting out the five minutes; an early report is never sent less than 30 seconds after the one before it. This is a complete example:

```
{ "v": 1, "at": "2026-09-19T12:00:00.000Z", "venue": "polymarket",
  "equityUsd": 1234.57, "netDepositsUsd": 1000, "profitUsd": 234.57,
  "volumeUsd": 4321.01, "boughtBackUsd": 0, "openPositions": 1,
  "lastAction": "Bought 200 \"Yes\" at 0.500 ($100.00). Will it happen?",
  "positions": [
    { "label": "Will it happen?", "venue": "polymarket", "side": "Yes",
      "sizeUsd": 104, "entryPrice": 0.5, "markPrice": 0.52, "pnlUsd": 4 } ],
  "trades": [
    { "at": "2026-09-19T11:58:30.000Z", "label": "Will it happen?",
      "action": "buy", "sizeUsd": 100, "price": 0.5 } ] }
```

That is everything a report can contain. Besides the API key, it is the only thing this program sends to Quotient. TokenStrats shows it on the public Projects page next to your strategy.

| Field | What it is |
|---|---|
| `v`, `at`, `venue` | The format version, the time, and `hyperliquid` or `polymarket`. |
| `equityUsd`, `netDepositsUsd`, `profitUsd`, `volumeUsd`, `openPositions` | The totals. Profit is equity less net deposits. |
| `boughtBackUsd` | Always 0: this release has no buyback. |
| `lastAction` | The runner's last log sentence, cut to 200 characters. |
| `positions` | What the bot holds, at most 20, largest first. `label` is the asset's name for Hyperliquid (the coin's ticker when it has no known name) or the market question for Polymarket, at most 80 characters. `side` is `long`, `short`, or the outcome bought, such as `Yes`. `sizeUsd` is the current value. `entryPrice`, `markPrice` and `pnlUsd` are `null` when the venue did not give the number. They come from the venue reading the cycle already made; the report causes no extra reads. |
| `trades` | The last 30 orders this runner had acknowledged, newest first: `open` and `close` on Hyperliquid, `buy`, `sell` and `redeem` on Polymarket, with the time, the same kind of label, the dollar size and the price (`null` for a redemption, or when the venue gave none). A stop or target that fills on the venue while the runner is idle is not in this list, because the runner did not send it. |
| `walletAddress` | Absent by default. See "Publishing the wallet address". |

A report never contains a key, a private key, an order id, a token id or a transaction hash. Anything shaped like an address, a transaction hash or an API key is removed from `lastAction` and from every `label` before the report is sent. Before sending, the runner checks the report against a schema that mirrors the server's and against the server's 24 KB limit. A report that fails either check is not sent: the runner logs one line and sends the ten totals alone. A gateway that does not yet accept `positions` and `trades` is handled the same way. A report that fails to send costs one log line; the cycle is never delayed or failed by it. Nothing in a report is an input to any target. `strats run --no-report` sends none, and a dry run sends none.

For Hyperliquid, net deposits and volume are read from the venue's own history. Polymarket has no deposit history to read, so net deposits there is what the funding step saw arrive (or, failing that, the wallet's value the first time the runner saw it), and volume is what the runner itself traded. The counters and the list of the last 30 trades live in `~/.strats/state/<id>.json`. None of it is secret. The only part of that file a decision reads is a theme bot's record of the markets it has already entered, attempted or redeemed; the trade list is for display.

### Publishing the wallet address

By default the report carries no address, and the project page shows only what the runner reports. During `init` you are asked once:

```
Show this bot's trades on its public project page? The wallet address becomes public. [y/N]
```

If you answer yes, each report also carries `walletAddress`: the Hyperliquid wallet address for a single-asset bot, or the Polymarket deposit wallet for a theme bot. A theme bot's signing address is never sent. A public address lets anyone look up everything that wallet holds and has done on the venue, not only what this bot did. The answer is stored as `publishWallet` in the bot file, which is not a secret, and travels to the droplet inside the settings so the deployed runner follows it.

To see or change it later:

```
strats config publish-wallet          # shows the current choice
strats config publish-wallet on
strats config publish-wallet off
```

A deployed runner keeps the choice it was deployed with until you run `strats deploy` again. When `init` runs without a terminal it does not ask, and the address is not published.

### Keys

A single-asset bot's keystore holds three entries: the master key (owns the funds, used only by `fund`), the trading key (an approved Hyperliquid agent that can trade but cannot withdraw, used by `run` and `close`), and the API key.

A theme bot's keystore holds the wallet key, the Polymarket API credentials, and the API key. Polymarket has no trading-only key: its SDK signs every order with the wallet's own key, and that key controls the deposit wallet that holds the funds. `run`, `status` and `close` therefore load it. Keep only what the bot needs in that wallet.

The bot file next to the keystore holds only addresses and settings.

## Commands

```
strats init --key qsk_... [--ceiling N] [--id name] [--gateway url] [--no-deploy] [--region blr1] [-y] [--force]
strats fund [--id name] [--dex name]
strats run [--id name] [--dry-run] [--once] [--interval 30] [--no-report] [--force-side long|short|flat]
strats deploy [--id name] [--region blr1] [--size s-1vcpu-1gb] [--from-tarball] [--dry-run] [-y]
strats logs [--id name] [--lines 50] [--follow]
strats destroy [--id name] [-y]
strats status [--id name]
strats close [--id name] [--coin COIN]
strats config [show|accept] [--id name]
strats config publish-wallet [on|off] [--id name]
```

**init** is the whole install, described under "Install". It reads your saved settings through the gateway and shows them, asks for your local ceiling, whether to publish the wallet address, and a keystore passphrase, creates the wallet, stores the API key encrypted, and pins the payout settings. For a theme key it also sets up the Polymarket account (a deposit wallet owned by the new key, API credentials, and the trading approvals, none of which cost anything). Then it runs the funding step and the deploy step, which are the same code as `fund` and `deploy`, and it asks for the passphrase only once. The key can also come from `STRATS_API_KEY` or a hidden prompt, which keeps it out of shell history.

Run again on a bot that exists, `init` continues from the first unfinished step and keeps the wallet; when every step is finished it says so and changes nothing. `--force` reads the settings again and replaces them, still keeping the wallet, your answer about publishing it, and the date profit is measured from. A key that belongs to a different bot is refused: use `--id` to create a second bot. `--no-deploy` stops after funding. `--region`, `--size`, `--from-tarball` and `-y` apply to the deploy step. `init` needs a terminal, because the funding step asks before each transfer.

**fund** is the funding step on its own. **fund**, single asset: waits for USDC on Arbitrum, deposits it into Hyperliquid, and approves the trading key. It asks before each transfer. It deposits the wallet's whole USDC balance. The wallet needs a little ETH on Arbitrum for gas. Deposits under 5 USDC are lost by the Hyperliquid bridge. For HIP-3 assets (coins like `xyz:NVDA`) it also sets Standard account mode and moves the deposit to that dex.

**fund**, theme: shows the address to send USDC to, waits for Polymarket's bridge to credit the deposit wallet, and checks the trading approvals. No gas is needed.

**run** is the loop. Each cycle it fetches the config (cached for 5 minutes) and the targets, reads the account and the market from the venue, decides, acts, and prints one line saying what it did and why. `--dry-run` sends nothing and says what it would do. For a single-asset bot a dry run loads no signing key at all; for a theme bot it loads the credentials, because Polymarket's balance and position reads need them, and hands them to a venue object that refuses every order. `--once` runs one cycle. On an error it prints one line, doubles the wait up to 5 minutes, and continues. Ctrl-C or SIGTERM exits without touching positions. `run` refuses to start while the bot is deployed, because two runners would trade the same wallet twice; `--force` overrides that if the droplet is gone.

Polymarket refuses orders from the United States and some other countries. A theme bot checks once at start; when it is blocked it prints one sentence naming `strats deploy`, then idles and checks again every 15 minutes. It opens and closes nothing from a blocked location.

`--force-side` (single asset only) replaces Q's target with a made-up one built from the live price (target 2% away, stop 1.5% the other way, entry limit halfway, expires in 1 hour) so you can test while Q is neutral. It is free to use with `--dry-run`. Without `--dry-run` it places a real order and also requires `--yes-place-a-real-order`.

**deploy** is the deploy step on its own, and the way to update a droplet after a change. It puts the runner on a DigitalOcean droplet in your own account and starts it as a service that restarts if it stops. It shows the plan, the monthly cost and what will be sent to the droplet, and asks y/N before creating anything; `-y` skips the question. `--dry-run` prints the plan and the first-boot script and calls nothing. See "Deploy" below.

**logs** prints the deployed runner's last lines over ssh (`--follow` keeps reading), or the local log file when the bot is not deployed.

**destroy** stops the runner and deletes the droplet and its firewall, after a y/N confirm. Positions and resting orders stay on the venue as they are. Billing for the droplet stops.

**status** shows the wallet, equity, positions, the current targets and whether they are fresh, the config version, your ceiling, the pinned payout settings, the profit split it would pay, and, for a deployed bot, whether the service is active and its last 20 log lines, read over ssh with `journalctl -u strats@<id> -n 20 --no-pager`.

**close**, single asset: cancels our target, closes the position with a reduce-only order, and then cancels our stop, after a y/N confirm. It cancels orders by id and never uses cancel-all. `--coin` names the coin yourself when the gateway cannot be reached. **close**, theme: sells every position in a configured market at the bid, after a y/N confirm, and leaves positions in other markets alone. A running bot will open again if the targets still say so, so stop it first if you want to stay out.

**config** compares the server's settings with the pinned payout settings. `accept` shows the exact change and re-pins after a y/N confirm. `publish-wallet` shows or changes whether reports carry the wallet address; see "Publishing the wallet address".

For unattended runs on your own machine set `STRATS_PASSPHRASE`. Data lives in `~/.strats` (`STRATS_HOME` overrides): `keys/`, `bots/<id>.json`, `state/<id>.json`, `logs/<id>.log`, `ssh/`.

## Deploy

```
strats deploy --dry-run     # the plan and the first-boot script; nothing is called or created
strats deploy               # asks before creating anything
```

`strats init` runs this as its last step. You need a DigitalOcean account and an API token with read and write scope. `deploy` looks for the token in `DIGITALOCEAN_TOKEN`, then `~/.strats/digitalocean.token`, then `~/.cassie/digitalocean.token`, then the `doctl` config, and otherwise asks for it and saves it with owner-only permissions. DigitalOcean bills you directly: the default size, `s-1vcpu-1gb`, is $6 per month until you run `strats destroy`.

What it does, in order:

1. Creates an ssh key under `~/.strats/ssh` if there is none and registers the public half with DigitalOcean.
2. Creates an Ubuntu 24.04 droplet named `strats-<id>` in the chosen region (default `blr1`). Its first-boot script installs Node, creates a `strats` system user, turns off ssh passwords, and turns on a firewall that allows inbound ssh only. The script contains no secrets, because a droplet's first-boot data is readable by anything on the box. `strats deploy --dry-run` prints it.
3. Adds a DigitalOcean firewall with the same rule: inbound port 22, nothing else.
4. Records the droplet's ssh host key before the first connection. Every later connection requires that same key.
5. Installs the runner at exactly this version: `npm install -g @quotient-forecasting/strats@<version>`. When this version is not on npm, or with `--from-tarball`, it packs the build on this machine, copies it over ssh, and installs that instead.
6. Sends the credentials over ssh standard input into `/etc/strats/<id>.env`, mode 0600, owned by the `strats` user. They never appear in a command line, in the first-boot data, or in DigitalOcean's API.
7. Starts the systemd unit `strats@<id>`, which runs `strats run --id <id>` with `Restart=always`, and waits until it is active.

A second `strats deploy` reuses the droplet when the region and size are unchanged: it updates the runner, replaces the credentials and restarts the service. Otherwise it replaces the droplet. A theme bot is refused a US region, because Polymarket refuses orders from there.

### What reaches the droplet

One value, `STRATS_RUNTIME_CREDS`, in that 0600 file. It holds:

- the API key and the gateway URL;
- the bot file: addresses, your ceiling, the pinned payout settings, and your choice about publishing the wallet address, none of it secret;
- for a single-asset bot, the Hyperliquid trading key and the wallet's public address. The trading key can place orders and cannot withdraw;
- for a theme bot, the Polymarket wallet key, the deposit wallet's address and the Polymarket API credentials. There is no trading-only key on Polymarket, so whoever controls the droplet controls the funds in that wallet. `deploy` says so before it asks.

The keystore file and its passphrase never leave your machine, and neither does a Hyperliquid master key. The droplet has no keystore: `run` reads `STRATS_RUNTIME_CREDS` when it is set and uses it instead, then removes it from its own environment.

## What the runner does with a target

| Situation | Action |
|---|---|
| Target is `long` or `short`, no position | Open, if every entry rule below passes |
| Target is `long` or `short`, position on the same side | Keep it. Make sure one stop and one target order rest at the target's prices; replace them when a new revision moves the prices |
| Target is `long` or `short`, position on the opposite side | Close. The new side opens on a later cycle |
| Now is at or after the signal's `expiresAt` | Close any position. Open nothing |
| Target is `flat` with reason `neutral` or `expired` | Close any position |
| Target is `flat` with reason `unavailable` | **Hold** |
| Gateway unreachable, any non-200 answer, or an answer that does not match the protocol | **Hold** |
| Now is past the target's `validUntil` | **Hold** |
| Mode is `reduce-only` | Open nothing. Keep managing and closing as above |

**Hold** means: open nothing, close nothing, leave the resting stop and target where they are. A fault never closes a position.

Entry rules: a long is never opened above `entryLimit` and a short never below it; nothing opens if the price has already crossed the stop or reached the target; one entry per signal revision (the order id is derived from the coin, signal id and revision, so the venue itself remembers, across restarts); at most three unfilled attempts per revision.

Order sequence for an entry: set isolated margin at 1x, send an immediate-or-cancel limit order, wait until the venue shows the position, place a stop sized to the actual position, then place the reduce-only target. If a stop cannot be placed the next cycles retry, and after 3 minutes without one the position is closed. If the price is already through the stop and no stop is resting, the position is closed.

## What the runner does with theme targets

The theme targets name the markets to hold (`targets`) and the configured markets that have resolved or closed (`closed`). Each target carries the outcome token to buy, a `maxPrice` and a `takeProfitPrice`.

| Situation | Action |
|---|---|
| A target's market is not held | Buy it once, with a fill-and-kill order at the ask, never above `maxPrice` |
| A target's market is held | Keep it. Buy no more |
| A held position's best bid is at or above `takeProfitPrice` | Sell it at the bid |
| A held position's market is in `closed` | Redeem it if it has resolved, otherwise sell it at the bid |
| A configured market is in neither list | Hold it as it is. Open nothing |
| A position the server never named | Left alone |
| A target outside the markets you configured, or naming the other outcome | Refused |
| Gateway unreachable, any non-200 answer, an answer that does not match the protocol, or now past `validUntil` | **Hold** |
| Mode is `reduce-only` | Open nothing. Keep selling and redeeming as above |

Before every buy the runner asks Polymarket for the wallet's balance of that exact token and does not buy if it holds any. A market is entered once: the runner records the target's id and never buys it again, even after a take-profit sale. If an order's result is unknown (a timeout after sending), it is not resent and that market is left alone for 15 minutes. A redemption is submitted once per market and never retried. At most three markets are entered per cycle. Sells are sized to what the wallet actually holds, so they can only reduce a position.

## Position size, the local ceiling, and pinned payout settings

Position size is a share of wallet equity at 1x isolated leverage:

```
percent  = min(server positionPct, your local ceiling, 50)
notional = equity x percent / 100, rounded down to the venue's size step
```

The ceiling is set at `init`, lives only on your machine, and the server cannot raise it. 50% is a hard cap in the code. If the rounded notional is under the $10 venue minimum, nothing opens and the line says how much to deposit.

A theme bot uses the same percent for each market it enters, in dollars of wallet value (free collateral plus the value of what is held). Everything held plus everything bought in a cycle never exceeds 100% of that value, and a buy never spends more than the free collateral. Polymarket's smallest order is 5 shares; a smaller budget opens nothing.

The token address, chain and profit split are pinned from the first config you approve at `init`. If the server later serves different values, the pinned ones stay in force and `run` prints one warning naming `strats config accept`. A change on the server alone can never redirect a payout.

## Account mode

The Hyperliquid adapter this program uses only opens positions when the account is in Hyperliquid's Standard account mode. For HIP-3 assets, `strats fund` sets it. For main-dex assets such as BTC, this release has no way to set it: a new account starts in Hyperliquid's "default" mode, and `run` will report that it is not opening for that reason. `status` shows the mode. Until a release closes this gap, the mode has to be changed on Hyperliquid itself using the wallet's master key.

## What this release does not do

- **Buyback.** The profit split is pinned and shown by `status`, but nothing is bought or paid out. No funds leave the wallet, and the report's `boughtBackUsd` is always 0.
- Withdrawals. Funds stay on the venue until you withdraw them with the wallet key using other tooling.
- Single asset: more than one position. One asset, one position, no pyramiding.
- Theme: stops. A theme position is sold at its take-profit price or when its market closes, and otherwise held to resolution. It can go to zero.
- Theme: adding to a position, or entering the same market a second time.
- Hosting on anything other than a DigitalOcean droplet in your own account.

## Risk

This software trades real money with no human in the loop. You can lose some or all of the funds in the wallet. Q's targets can be wrong. A prediction-market share pays nothing when its outcome does not happen. Stops are market orders triggered on the venue and can fill far from the stop price in a fast market or a gap, and perpetual positions pay or receive funding. Hyperliquid, the Arbitrum bridge, the gateway or your own machine can fail or be unreachable; while the runner is down, only the stop and target orders already resting on the venue protect a position. Anyone who has both the keystore file and its passphrase controls the wallet, and there is no recovery if you lose either. Anyone who gains control of a deployed droplet can trade a single-asset bot's account and can take a theme bot's funds. The software is provided as is, without warranty, under the Apache-2.0 license. Start with `--dry-run`, then with an amount you can afford to lose.

## Development

```
npm install
npm test        # unit tests: both decision functions, protocol, client, venues, deploy, runtime credentials, report, trade list, init stages
npm run build
```

`src/reconcile.ts` and `src/reconcile-theme.ts` are the decision functions: pure, no I/O, fully tested. `src/venue.ts` and `src/venue-polymarket.ts` are the only files that place orders. `src/commands/fund.ts` is the only file that causes a Hyperliquid master key to be read. `src/runtime-creds.ts` defines, with a strict schema, everything a droplet can receive. `src/install.ts` is the pure function that decides which step of `init` comes next. `src/report.ts` builds the report, and `src/protocol/index.ts` holds the schema every report is checked against before it is sent. `src/deploy/` is adapted from the deploy code in cassie (Apache-2.0, same organisation); each file names its source.
