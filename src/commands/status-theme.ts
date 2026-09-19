// strats status for a theme or team bot, and for the Polymarket side of a single-asset bot. Read-only: the venue it builds refuses every order.
import { describeAutoBuyback } from "../buyback/text.js";
import { ASSET_SOURCE, sourceFor } from "../polymarket-source.js";
import { TEAM_BET_MODES, type ConfigDoc } from "../protocol/index.js";
import { usd } from "../reconcile.js";
import { describeThemeDecision, reconcileTheme, themeEffectivePct } from "../reconcile-theme.js";
import { depositsLessWithdrawals, payoutRows, summary } from "../payouts.js";
import { loadRuntimeState } from "../runtime-state.js";
import { loadPolymarketCreds, type Session } from "../session.js";
import { marketsStateScope, pinnedDifferences } from "../state.js";
import { gameCounts } from "../team-markets.js";
import { PolymarketVenue } from "../venue-polymarket.js";
import { describePublication } from "./config.js";
import { chainName } from "./init.js";
import { payoutNote, row, showDeployment } from "./status.js";

export async function statusTheme(session: Session): Promise<number> {
  const { bot } = session;
  const source = sourceFor(bot);
  const [config, targets] = await Promise.all([source.fetchConfig(session.gateway), source.fetchTargets(session.gateway)]);
  const now = Date.now();

  console.log(`Bot "${bot.id}" (${source.strategyId === "team" ? "back a team" : "your own theme"}, on Polymarket)`);
  row("Deposit wallet", bot.polymarket?.funder ?? "not set up yet (run strats init)");
  row("Signing address", bot.masterAddress);
  row("API key", `${bot.keyPrefix}...`);
  row("Ceiling", `${bot.ceilingPct}% of the wallet per position`);
  row("Project page", describePublication(bot));
  row("Auto-buyback", describeAutoBuyback(bot));

  console.log("Settings");
  if (config.ok) {
    const { account } = config.value.config;
    row("Config version", `${config.value.version}, updated ${config.value.updatedAt}`);
    if (config.value.config.strategyId === "team") {
      const { strategy } = config.value.config;
      const bet = TEAM_BET_MODES.find((m) => m.value === strategy.mode);
      row("Team", strategy.team.name);
      row("League", strategy.team.league.toUpperCase());
      row("Bet", bet?.label ?? strategy.mode);
      if (bet?.usesMargin) row("Lead needed", `${strategy.marginPts} point${strategy.marginPts === 1 ? "" : "s"}`);
      row("Pay at most", `${strategy.maxPriceCents}¢`);
    } else if (config.value.config.strategyId === "theme") {
      const { strategy } = config.value.config;
      row("Thesis", strategy.thesis);
      row("Markets", `${strategy.markets.length} configured`);
    }
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
    if (targets.value.strategyId === "team") {
      // A team whose name changed on Polymarket shows up here as no games at all.
      const games = gameCounts(targets.value);
      row("Games", `${games.upcoming} upcoming, ${games.live} live, ${games.closed} finished in the last 14 days`);
    } else {
      row("Closed", `${targets.value.closed.length} market${targets.value.closed.length === 1 ? "" : "s"}`);
    }
  } else {
    row("Targets", `not available. ${targets.message} The runner holds in this state.`);
  }

  console.log("Polymarket");
  if (!bot.polymarket) {
    row("Account", "not set up yet. Run: strats init");
    return 1;
  }
  // Without the targets a team bot has no games to look in; a theme bot still has the markets from its settings.
  const allowed = targets.ok ? source.marketsFor(config.ok ? config.value : undefined, targets.value) : undefined;
  const markets = allowed?.markets ?? (config.ok && config.value.config.strategyId === "theme" ? config.value.config.strategy.markets : []);
  for (const note of allowed?.refused ?? []) row("Refused", note);
  const venue = new PolymarketVenue(bot.polymarket, loadPolymarketCreds(session), { readOnly: true });
  const snap = await venue.snapshot(markets, allowed?.quoteTokenIds ?? []);
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
    console.log(bot.deployment.autoBuyback === true
      ? "  The figures below use this machine's deposits figure, which is also what the droplet's automatic buyback measures profit from, and the droplet's payout record."
      : "  The deployed runner keeps its own totals on the droplet. The figures below are from this machine.");
  }
  if (state.netDepositsUsd !== undefined) {
    const payouts = summary(bot.id);
    const deposits = depositsLessWithdrawals(state.netDepositsUsd, state.netDepositsAt, payouts.withdrawals);
    const profit = Math.max(0, snap.equityUsd - deposits);
    const toSplit = Math.max(0, profit - payouts.settledUsd);
    row("Profit", `${usd(profit)} (equity ${usd(snap.equityUsd)} less deposits ${usd(deposits)} recorded on this machine, buyback withdrawals taken off)`);
    row("Would pay", `${usd((toSplit * bot.pinned.split.buybackPct) / 100)} to buy the token, ${usd((toSplit * bot.pinned.split.keepPct) / 100)} kept, of ${usd(toSplit)} not yet split`);
    for (const line of payoutRows(bot.id)) console.log(line);
  } else {
    row("Profit", "not shown: no deposit has been recorded yet");
  }
  console.log(payoutNote(bot));

  console.log("Next cycle");
  const decision = reconcileTheme({
    targets: allowed ? { ok: true, doc: allowed.doc } : { ok: false, reason: targets.ok ? "" : targets.message },
    now: Date.now(), markets, holdings: snap.holdings, quotes: snap.quotes,
    collateralUsd: snap.collateralUsd, equityUsd: snap.equityUsd, exposureUsd: snap.exposureUsd,
    positionPct: config.ok ? config.value.config.account.positionPct : 0, ceilingPct: bot.ceilingPct,
    blockedTargetIds: Object.keys(state.entered), redeemedConditionIds: Object.keys(state.redeemed), pendingTokenIds: snap.pendingTokenIds,
    ...(config.ok ? {} : { openBlockedReason: `The settings could not be loaded (${config.message}) Not opening.` }),
  });
  console.log(`  ${describeThemeDecision(decision, true)}`);
  return 0;
}

/** The Polymarket side of a single-asset bot that also trades markets: the targets, the wallet, and what the next cycle would do. */
export async function statusMarkets(session: Session, config: ConfigDoc | undefined): Promise<void> {
  const { bot } = session;
  const targets = await ASSET_SOURCE.fetchTargets(session.gateway);
  const now = Date.now();

  console.log("Market targets");
  const allowed = targets.ok ? ASSET_SOURCE.marketsFor(config, targets.value) : undefined;
  if (targets.ok && allowed) {
    row("Mode", targets.value.mode);
    row("Fresh", now <= Date.parse(targets.value.validUntil) ? `yes, valid until ${targets.value.validUntil}` : `no, expired at ${targets.value.validUntil}`);
    row("To hold", `${allowed.doc.targets.length} market${allowed.doc.targets.length === 1 ? "" : "s"}`);
    for (const t of allowed.doc.targets.slice(0, 40)) console.log(`    ${t.outcome} at up to ${t.maxPrice}${t.q !== null ? `, Q ${t.q}` : ""}: ${t.question}`);
    row("Closed", `${targets.value.closed.length} market${targets.value.closed.length === 1 ? "" : "s"}`);
    for (const note of allowed.refused) row("Refused", note);
  } else if (!targets.ok) {
    row("Targets", `not available. ${targets.message} The markets hold in this state. The perp is not affected.`);
  }

  console.log("Polymarket");
  if (!bot.polymarket) {
    row("Account", "not set up yet. Run: strats init");
    return;
  }
  const markets = allowed?.markets ?? config?.config.strategy.markets ?? [];
  const venue = new PolymarketVenue(bot.polymarket, loadPolymarketCreds(session), { readOnly: true });
  const snap = await venue.snapshot(markets, allowed?.quoteTokenIds ?? []);
  row("Equity", `${usd(snap.equityUsd)}: ${usd(snap.collateralUsd)} free, ${usd(snap.exposureUsd)} in positions`);
  const configured = new Set(markets.flatMap((m) => m.tokenIds));
  for (const h of snap.holdings) {
    const question = markets.find((m) => m.tokenIds.includes(h.tokenId))?.question ?? h.label ?? h.tokenId.slice(0, 12);
    row(configured.has(h.tokenId) ? "Position" : "Other position", `${h.size} shares worth ${usd(h.valueUsd)}${h.redeemable ? ", redeemable" : ""}: ${question}${configured.has(h.tokenId) ? "" : " (not managed by this bot)"}`);
  }
  if (snap.holdings.length === 0) row("Positions", "none");

  console.log("Next cycle, markets");
  const state = loadRuntimeState(bot.id, marketsStateScope(bot));
  const decision = reconcileTheme({
    targets: allowed ? { ok: true, doc: allowed.doc } : { ok: false, reason: targets.ok ? "" : targets.message },
    now: Date.now(), markets, holdings: snap.holdings, quotes: snap.quotes,
    collateralUsd: snap.collateralUsd, equityUsd: snap.equityUsd, exposureUsd: snap.exposureUsd,
    positionPct: config?.config.account.positionPct ?? 0, ceilingPct: bot.ceilingPct,
    blockedTargetIds: Object.keys(state.entered), redeemedConditionIds: Object.keys(state.redeemed), pendingTokenIds: snap.pendingTokenIds,
    ...(config ? {} : { openBlockedReason: "The settings could not be loaded. Not opening." }),
  });
  console.log(`  ${describeThemeDecision(decision, true)}`);
}
