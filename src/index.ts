// Library surface: the protocol, the gateway client, and the pure decision function.
// Nothing exported here touches keys or the venue.
export * from "./protocol/index.js";
export { DEFAULT_GATEWAY_URL, fetchConfig, fetchTarget, normalizeGatewayUrl, type FetchFailureKind, type FetchResult, type GatewayOptions } from "./client.js";
export {
  ENTRY_SLIPPAGE_PCT, HARD_CAP_PCT, VENUE_MIN_NOTIONAL_USD,
  describeDecision, effectivePct, floorToDecimals, holdReason, reconcile, venuePrice,
  type Decision, type OrderView, type PositionView, type ReconcileInput, type Side, type TargetInput,
} from "./reconcile.js";
export { pinnedDifferences, type BotState, type Pinned } from "./state.js";
