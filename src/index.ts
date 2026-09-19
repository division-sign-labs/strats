// Library surface: the protocol, the gateway client, and the pure decision function.
// Nothing exported here touches keys or the venue.
export * from "./protocol/index.js";
export {
  DEFAULT_GATEWAY_URL, discoverConfig, fetchConfig, fetchConfigFor, fetchTarget, fetchTeamConfig, fetchTeamTargets, fetchThemeConfig, fetchThemeTargets, normalizeGatewayUrl, postReport,
  type FetchFailureKind, type FetchResult, type GatewayOptions,
} from "./client.js";
export {
  THEME_HARD_CAP_PCT, THEME_MAX_BUYS_PER_CYCLE, describeThemeDecision, reconcileTheme, themeEffectivePct, themeHoldReason,
  type ThemeAction, type ThemeDecision, type ThemeHolding, type ThemeQuote, type ThemeReconcileInput, type ThemeTargetsInput,
} from "./reconcile-theme.js";
export { gameCounts, teamMarketsForCycle, themeView, type TeamCycleMarkets } from "./team-markets.js";
export { nextInitStage, isFunded, type InitFacts, type InitStage } from "./install.js";
export { buildReport, sanitizeAction, sanitizeLabel, type ReportFigures } from "./report.js";
export {
  ENTRY_SLIPPAGE_PCT, HARD_CAP_PCT, VENUE_MIN_NOTIONAL_USD,
  describeDecision, effectivePct, floorToDecimals, holdReason, reconcile, venuePrice,
  type Decision, type OrderView, type PositionView, type ReconcileInput, type Side, type TargetInput,
} from "./reconcile.js";
export { pinnedDifferences, type BotState, type Pinned } from "./state.js";
