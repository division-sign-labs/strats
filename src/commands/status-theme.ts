// strats status for a theme bot. Read-only: the venue it builds refuses every order.
import { fetchThemeConfig, fetchThemeTargets } from "../client.js";
import { usd } from "../reconcile.js";
import { describeThemeDecision, reconcileTheme, themeEffectivePct } from "../reconcile-theme.js";
import { loadRuntimeState } from "../runtime-state.js";
import { loadPolymarketCreds, type Session } from "../session.js";
import { pinnedDifferences } from "../state.js";
import { PolymarketVenue } from "../venue-polymarket.js";
import { describePublication } from "./config.js";
import { chainName } from "./init.js";
import { row, showDeployment } from "./status.js";

export async function statusTheme(session: Session): Promise<number> {
  const { bot } = session;
  const [config, targets] = await Promise.all([fetchThemeConfig(session.gateway), fetchThemeTargets(session.gateway)]);
  const now = Date.now();

  console.log(`Bot "${bot.id}" (your own theme, on Polymarket)`);
  row("Deposit wallet", bot.polymarket?.funder ?? "not set up yet (run strats init)");
  row("Signing address", bot.masterAddress);
  row("API key", `${bot.keyPrefix}...`);
  row("Ceiling", `${bot.ceilingPct}% of the wallet per position`);
  row("Project page", describePublication(bot));

  console.log("Settings");
  if (config.ok) {
    const { strategy, account } = config.value.config;
    row("Config version", `${config.value.version}, updated ${config.value.updatedAt}`);
    row("Thesis", strategy.thesis);
    row("Markets", `${strategy.markets.length} configured`);
    row("Position size", `${account.positionPct}% configured, ${themeEffectivePct(account.positionPct, bot.ceilingPct)}% in force`);
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

  console.log("Targets");
  if (targets.ok) {
    row("Mode", targets.value.mode);
    row("Fresh", now <= Date.parse(targets.value.validUntil) ? `yes, valid until ${targets.value.validUntil}` : `no, expired at ${targets.value.validUntil}`);
    row("To hold", `${targets.value.targets.length} market${targets.value.targets.length === 1 ? "" : "s"}`);
    for (const t of targets.value.targets.slice(0, 40)) console.log(`    ${t.outcome} at up to ${t.maxPrice}${t.q !== null ? `, Q ${t.q}` : ""}: ${t.question}`);
    row("Closed", `${targets.value.closed.length} market${targets.value.closed.length === 1 ? "" : "s"}`);
  } else {
    row("Targets", `not available. ${targets.message} The runner holds in this state.`);
  }

  console.log("Polymarket");
  if (!bot.polymarket) {
    row("Account", "not set up yet. Run: strats init");
    return 1;
  }
  const markets = config.ok ? config.value.config.strategy.markets : [];
  const venue = new PolymarketVenue(bot.polymarket, loadPolymarketCreds(session), { readOnly: true });
  const tokenIds = targets.ok ? [...targets.value.targets.map((t) => t.tokenId), ...targets.value.closed.map((c) => c.tokenId)] : [];
  const snap = await venue.snapshot(markets, tokenIds);
  row("Equity", `${usd(snap.equityUsd)}: ${usd(snap.collateralUsd)} free, ${usd(snap.exposureUsd)} in positions`);
  const configured = new Set(markets.flatMap((m) => m.tokenIds));
  for (const h of snap.holdings) {
    const question = markets.find((m) => m.tokenIds.includes(h.tokenId))?.question ?? h.label ?? h.tokenId.slice(0, 12);
    row(configured.has(h.tokenId) ? "Position" : "Other position", `${h.size} shares worth ${usd(h.valueUsd)}${h.redeemable ? ", redeemable" : ""}: ${question}${configured.has(h.tokenId) ? "" : " (not managed by this bot)"}`);
  }
  if (snap.holdings.length === 0) row("Positions", "none");

  console.log("Profit split");
  const state = loadRuntimeState(bot.id);
  if (bot.deployment) {
    console.log("  The deployed runner keeps its own totals on the droplet. The figures below are from this machine.");
  }
  if (state.netDepositsUsd !== undefined) {
    const profit = Math.max(0, snap.equityUsd - state.netDepositsUsd);
    row("Profit", `${usd(profit)} (equity ${usd(snap.equityUsd)} less deposits ${usd(state.netDepositsUsd)} recorded by strats fund)`);
    row("Would pay", `${usd((profit * bot.pinned.split.buybackPct) / 100)} to buy the token, ${usd((profit * bot.pinned.split.keepPct) / 100)} kept`);
  } else {
    row("Profit", "not shown: no deposit has been recorded yet");
  }
  console.log("  The buyback is not implemented in this release. Nothing is paid out and no funds leave the wallet.");

  console.log("Next cycle");
  const decision = reconcileTheme({
    targets: targets.ok ? { ok: true, doc: targets.value } : { ok: false, reason: targets.message },
    now: Date.now(), markets, holdings: snap.holdings, quotes: snap.quotes,
    collateralUsd: snap.collateralUsd, equityUsd: snap.equityUsd, exposureUsd: snap.exposureUsd,
    positionPct: config.ok ? config.value.config.account.positionPct : 0, ceilingPct: bot.ceilingPct,
    blockedTargetIds: Object.keys(state.entered), redeemedConditionIds: Object.keys(state.redeemed), pendingTokenIds: snap.pendingTokenIds,
    ...(config.ok ? {} : { openBlockedReason: `The settings could not be loaded (${config.message}) Not opening.` }),
  });
  console.log(`  ${describeThemeDecision(decision, true)}`);
  return 0;
}
