// strats status: everything worth knowing, read fresh from the gateway and the venue. Read-only.
import type { Args } from "../args.js";
import { fetchConfig, fetchTarget } from "../client.js";
import { describeDecision, px, reconcile, usd } from "../reconcile.js";
import { sshExec } from "../deploy/ssh.js";
import { payoutRows, summary } from "../payouts.js";
import type { ConfigDoc } from "../protocol/index.js";
import { openSession, type Session } from "../session.js";
import type { Prompts } from "../setup.js";
import { isPolymarketBot, isTwoVenueBot, pinnedDifferences, type BotState } from "../state.js";
import { Venue, toOrderView } from "../venue.js";
import { describePublication } from "./config.js";
import { chainName } from "./init.js";
import { openBlocked, toReconcileInput } from "./run.js";

export const row = (label: string, value: string): void => console.log(`  ${label.padEnd(16)} ${value}`);

/** The deployed runner's own last lines, read over ssh. A failure here never hides the rest of the status. */
export function showDeployment(bot: BotState): void {
  console.log("Deployed runner");
  if (!bot.deployment) {
    row("Droplet", "none. This bot runs only where you run it. strats deploy puts it on a droplet.");
    return;
  }
  const d = bot.deployment;
  row("Droplet", `${d.host} (${d.region}, ${d.size}), runner ${d.version}, deployed ${d.deployedAt}`);
  const unit = `strats@${bot.id}`;
  const result = sshExec({ host: d.host, user: "root" }, `systemctl is-active ${unit}; journalctl -u ${unit} -n 20 --no-pager -o cat`, undefined, { timeoutMs: 30_000 });
  const lines = result.stdout.trimEnd().split("\n");
  if (!result.stdout.trim()) {
    row("Service", `could not be read over ssh. ${(result.stderr || "").trim().slice(0, 200)}`);
    return;
  }
  row("Service", lines[0] ?? "unknown");
  for (const line of lines.slice(1)) console.log(`    ${line}`);
}

export async function status(args: Args, prompts: Prompts): Promise<number> {
  const session = await openSession(args, prompts);
  prompts.close();
  const { bot } = session;
  if (isPolymarketBot(bot)) return (await import("./status-theme.js")).statusTheme(session);
  const [config, target] = await Promise.all([fetchConfig(session.gateway), fetchTarget(session.gateway)]);
  const now = Date.now();

  console.log(`Bot "${bot.id}"`);
  row("Wallet", bot.masterAddress);
  row("Trading key", bot.agentAddress ?? "not approved yet (run strats fund)");
  if (isTwoVenueBot(bot)) row("Polymarket", bot.polymarket ? `deposit wallet ${bot.polymarket.funder}${bot.markets?.fundedAt ? "" : ", not funded yet (run strats fund --venue polymarket)"}` : "not set up yet (run strats init)");
  row("API key", `${bot.keyPrefix}...`);
  row("Ceiling", `${bot.ceilingPct}% of the wallet per position`);
  row("Project page", describePublication(bot));

  console.log("Settings");
  if (config.ok) {
    const { strategy, account } = config.value.config;
    row("Config version", `${config.value.version}, updated ${config.value.updatedAt}`);
    row("Asset", strategy.assetKey);
    if (isTwoVenueBot(bot)) row("Markets", `${strategy.markets?.length ?? 0} on Polymarket`);
    row("Position size", `${account.positionPct}% configured, ${Math.min(account.positionPct, bot.ceilingPct, 50)}% in force`);
  } else {
    row("Config", `not available. ${config.message}`);
  }
  row("Pinned token", `${bot.pinned.token.address} on ${chainName(bot.pinned.token.chainId)}`);
  row("Pinned split", `${bot.pinned.split.buybackPct}% buys the token, ${bot.pinned.split.keepPct}% is kept`);
  if (config.ok) {
    const differences = pinnedDifferences(bot.pinned, config.value.config.account);
    if (differences.length > 0) row("Server differs", `${differences.join("; ")}. The pinned values stay in force until: strats config accept`);
  }

  showDeployment(bot);

  console.log("Target");
  if (!target.ok) {
    row("Target", `not available. ${target.message}`);
    console.log("The venue is not shown because the target names the coin. The runner holds in this state.");
    if (isTwoVenueBot(bot)) await showMarkets(session, config.ok ? config.value : undefined);
    return 1;
  }
  const t = target.value.target;
  row("Coin", `${t.coin} on ${t.dex ? `the "${t.dex}" dex` : "the main dex"}`);
  row("Side", t.side === "flat" ? `flat (${t.flatReason})` : `${t.side}, entry limit ${px(t.entryLimit ?? 0)}, target ${px(t.targetPx ?? 0)}, stop ${px(t.stopPx ?? 0)}`);
  if (t.side !== "flat") row("Signal", `${t.signalId ?? "no id"}, revision ${t.revision ?? "none"}, expires ${t.expiresAt ?? "never"}`);
  row("Mode", target.value.mode);
  row("Reason", t.reason);
  row("Fresh", now <= Date.parse(target.value.validUntil) ? `yes, valid until ${target.value.validUntil}` : `no, expired at ${target.value.validUntil}`);

  console.log("Hyperliquid");
  const venue = new Venue({ coin: t.coin, dex: t.dex, masterAddress: bot.masterAddress, ...(bot.agentAddress ? { agentAddress: bot.agentAddress } : {}) });
  const snap = await venue.snapshot();
  row("Account mode", snap.standardMode ? "Standard" : `"${snap.accountMode}" (positions can only be opened in Standard mode)`);
  row("Equity", `${usd(snap.equityUsd)}, ${usd(snap.availableUsd)} free`);
  if (t.dex && snap.fundingBalanceUsd > 0) row("Not yet moved", `${usd(snap.fundingBalanceUsd)} in the main account (run strats fund)`);
  row("Price", `${px(snap.market.quote.mid)} (bid ${px(snap.market.quote.bid)}, ask ${px(snap.market.quote.ask)})`);
  const p = snap.position;
  row("Position", p ? `${p.side.toLowerCase()} ${p.size} ${t.coin} from ${px(p.avgPrice)}, unrealized ${usd(p.unrealizedPnl ?? 0)}, ${p.marginMode ?? "unknown"} margin at ${p.leverage ?? "?"}x` : "none");
  const exits = snap.orders.map(toOrderView).filter((o) => o.reduceOnly);
  const stop = exits.find((o) => o.isTrigger && o.triggerKind === "sl");
  const limit = exits.find((o) => !o.isTrigger);
  row("Stop order", stop ? `${px(stop.triggerPx ?? 0)} for ${stop.remainingSize} (order ${stop.id})` : "none");
  row("Target order", limit ? `${px(limit.price)} for ${limit.remainingSize} (order ${limit.id})` : "none");
  for (const other of snap.otherPositions) row("Other position", `${other.side.toLowerCase()} ${other.size} ${other.marketRef} (not managed by this bot)`);

  console.log("Profit split");
  try {
    const deposits = await venue.netDeposits(Date.parse(bot.createdAt));
    if (deposits.complete) {
      const profit = Math.max(0, snap.equityUsd - deposits.amountUsd);
      const toSplit = Math.max(0, profit - summary(bot.id).settledUsd);
      row("Profit", `${usd(profit)} (equity ${usd(snap.equityUsd)} less net deposits ${usd(deposits.amountUsd)}, open positions included)`);
      row("Would pay", `${usd((toSplit * bot.pinned.split.buybackPct) / 100)} to buy the token, ${usd((toSplit * bot.pinned.split.keepPct) / 100)} kept, of ${usd(toSplit)} not yet split`);
      for (const line of payoutRows(bot.id)) console.log(line);
    } else {
      row("Profit", "not shown: the deposit history could not be read in full");
    }
  } catch (error) {
    row("Profit", `not shown: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (isTwoVenueBot(bot)) console.log("  The profit split counts the Hyperliquid account. What the Polymarket wallet earns is not split by strats buyback yet.");
  console.log("  Nothing is paid out by itself. strats buyback shows the plan; strats buyback --execute carries it out, from this machine only.");

  console.log("Next cycle");
  const decision = reconcile(toReconcileInput({ ok: true, doc: target.value }, snap, Date.now(), config.ok ? config.value.config.account.positionPct : 0, bot.ceilingPct, true, openBlocked(config.ok ? config.value : undefined, config.ok ? "" : config.message, snap)));
  console.log(`  ${describeDecision(decision, t.coin, true)}`);
  if (isTwoVenueBot(bot)) await showMarkets(session, config.ok ? config.value : undefined);
  return 0;
}

/** The Polymarket side of a two-venue bot. A failure here never hides the perp's status above. */
async function showMarkets(session: Session, config: ConfigDoc | undefined): Promise<void> {
  try {
    await (await import("./status-theme.js")).statusMarkets(session, config);
  } catch (error) {
    console.log("Polymarket");
    row("Markets", `could not be read. ${error instanceof Error ? error.message : String(error)}`);
  }
}
