# strats

`strats` runs a TokenStrats strategy from your own wallet. Quotient decides what to hold and serves it as a declarative target; this program holds the keys, sizes the position, and places the orders on Hyperliquid. It keeps no trading state of its own: every cycle it reads the target and the venue from scratch and converges, so downtime, restarts and missed updates need no replay.

## Non-custodial, and what leaves the machine

The wallet is created on your machine. Its private keys are encrypted in a local keystore (scrypt + AES-256-GCM, file mode 0600) and are never sent anywhere. Quotient cannot move funds, place orders, or see the account.

Information flows one way: config and target come down, nothing goes up. This is everything the program sends:

| To | What | When |
|---|---|---|
| Quotient gateway | Two `GET` requests with the API key in the `x-quotient-api-key` header. No body, no wallet address, no balance, no position, no order. | `init`, `run`, `status`, `config`, `fund`, `close` |
| Hyperliquid API | Read queries keyed by the wallet's public address. Orders, cancels and the leverage setting, signed locally by the trading key. | `run`, `status`, `close` |
| Hyperliquid API and an Arbitrum RPC | Balance reads, the USDC deposit transaction, the trading-key approval and the account setup, signed locally by the master key. | `fund` only |

Nothing else. There is no telemetry, no error reporting and no update check. The gateway sees your IP address and the API key, as any web server would.

The keystore holds three entries: the master key (owns the funds, used only by `fund`), the trading key (an approved Hyperliquid agent that can trade but cannot withdraw, used by `run` and `close`), and the API key. The bot file next to it holds only addresses and settings.

## Install

Node 22 or newer.

```
npm install -g @quotient-forecasting/strats
```

or run it without installing: `npx @quotient-forecasting/strats --help`.

## Commands

```
strats init --key qsk_... [--ceiling N] [--id name] [--gateway url] [--force]
strats fund [--id name]
strats run [--id name] [--dry-run] [--once] [--interval 30] [--force-side long|short|flat]
strats status [--id name]
strats close [--id name] [--coin COIN]
strats config [show|accept] [--id name]
```

**init** reads your saved settings through the gateway and shows them (asset, position size, token, profit split). It asks for your local ceiling and a keystore passphrase, creates the wallet, stores the API key encrypted, pins the payout settings, and prints the address to fund. The key can also come from `STRATS_API_KEY` or a hidden prompt, which keeps it out of shell history. It refuses to replace an existing bot unless `--force`; with `--force` the settings are replaced and the wallet is kept.

**fund** waits for USDC on Arbitrum, deposits it into Hyperliquid, and approves the trading key. It asks before each transfer. It deposits the wallet's whole USDC balance. The wallet needs a little ETH on Arbitrum for gas. Deposits under 5 USDC are lost by the Hyperliquid bridge. For HIP-3 assets (coins like `xyz:NVDA`) it also sets Standard account mode and moves the deposit to that dex.

**run** is the loop. Each cycle it fetches the config (cached for 5 minutes) and the target, reads the account and market from Hyperliquid, decides, acts, and prints one line saying what it did and why. `--dry-run` loads no signing key and sends nothing; it says what it would do. `--once` runs one cycle. On an error it prints one line, doubles the wait up to 5 minutes, and continues. Ctrl-C or SIGTERM exits without touching positions; the stop and target orders stay on the venue.

`--force-side` replaces Q's target with a made-up one built from the live price (target 2% away, stop 1.5% the other way, entry limit halfway, expires in 1 hour) so you can test while Q is neutral. It is free to use with `--dry-run`. Without `--dry-run` it places a real order and also requires `--yes-place-a-real-order`.

**status** shows the wallet, equity, position, our stop and target orders, the current target and whether it is fresh, the config version, your ceiling, the pinned payout settings, and the profit split it would pay.

**close** cancels our target, closes the position with a reduce-only order, and then cancels our stop, after a y/N confirm. It cancels orders by id and never uses cancel-all. `--coin` names the coin yourself when the gateway cannot be reached. A running bot will open again if the target still says so, so stop it first if you want to stay flat.

**config** compares the server's settings with the pinned payout settings. `accept` shows the exact change and re-pins after a y/N confirm.

For unattended runs set `STRATS_PASSPHRASE`. `run` only ever loads the trading key and the API key. Data lives in `~/.strats` (`STRATS_HOME` overrides): `keys/`, `bots/<id>.json`, `logs/<id>.log`.

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

## Position size, the local ceiling, and pinned payout settings

Position size is a share of wallet equity at 1x isolated leverage:

```
percent  = min(server positionPct, your local ceiling, 50)
notional = equity x percent / 100, rounded down to the venue's size step
```

The ceiling is set at `init`, lives only on your machine, and the server cannot raise it. 50% is a hard cap in the code. If the rounded notional is under the $10 venue minimum, nothing opens and the line says how much to deposit.

The token address, chain and profit split are pinned from the first config you approve at `init`. If the server later serves different values, the pinned ones stay in force and `run` prints one warning naming `strats config accept`. A change on the server alone can never redirect a payout.

## Account mode

The Hyperliquid adapter this program uses only opens positions when the account is in Hyperliquid's Standard account mode. For HIP-3 assets, `strats fund` sets it. For main-dex assets such as BTC, this release has no way to set it: a new account starts in Hyperliquid's "default" mode, and `run` will report that it is not opening for that reason. `status` shows the mode. Until a release closes this gap, the mode has to be changed on Hyperliquid itself using the wallet's master key.

## What v1 does not do

- **Buyback.** The profit split is pinned and shown by `status`, but nothing is bought or paid out. No funds leave the wallet.
- **Reports.** Nothing is sent up to Quotient: no fills, no balances, no performance.
- **Droplet deploy.** There is no hosted or one-command server setup. Run it on a machine you control.
- **Polymarket** or any venue other than Hyperliquid perps.
- Withdrawals. Funds stay on Hyperliquid until you withdraw them with the master key using other tooling.
- More than one position. One asset, one position, no pyramiding.

## Risk

This software trades real money with no human in the loop. You can lose some or all of the funds in the wallet. Q's targets can be wrong. Stops are market orders triggered on the venue and can fill far from the stop price in a fast market or a gap, and perpetual positions pay or receive funding. Hyperliquid, the Arbitrum bridge, the gateway or your own machine can fail or be unreachable; while the runner is down, only the stop and target orders already resting on the venue protect a position. Anyone who has both the keystore file and its passphrase controls the wallet, and there is no recovery if you lose either. The software is provided as is, without warranty, under the Apache-2.0 license. Start with `--dry-run`, then with an amount you can afford to lose.

## Development

```
npm install
npm test        # unit tests: decision function, protocol, client, venue sequence
npm run build
```

`src/reconcile.ts` is the whole decision function: pure, no I/O, fully tested. `src/venue.ts` is the only file that places orders. `src/commands/fund.ts` is the only file that causes the master key to be read.
