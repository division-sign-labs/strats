// The local check for a single-asset bot's Polymarket markets. On a legacy key the
// creator chose the markets and a direction. On a managed key the server chooses
// the markets, and each one is confirmed on Polymarket instead (managed-markets.ts);
// which outcome is the long side is then the server's word, so the direction is
// not checked here. Each cycle the targets the server names are checked
// against both and against the rule itself: Q has forecast the market, the price
// limit is at least 70 cents and at most 97, and Q is at least 5 points above it.
// A target that fails is dropped, and its market stays so a holding can still be
// sold or redeemed. What passes is traded by the unchanged reconcileTheme function.
// Pure: no I/O, no clock.
import { THEME_STRATEGY_ID, type AssetMarketsTargetsDoc, type ConfigDoc, type ThemeMarket, type ThemeTargetsDoc } from "./protocol/index.js";

/** An outcome is bought only at this price or above. */
export const ASSET_MARKET_MIN_PRICE = 0.7;
/** Q's probability must be this far above the price. */
export const ASSET_MARKET_MIN_EDGE = 0.05;
/** Never pay above this, whatever Q says. */
export const ASSET_MARKET_MAX_PRICE = 0.97;

export interface AssetCycleMarkets {
  /** The configured markets. `side` is the outcome this cycle may buy. */
  markets: ThemeMarket[];
  /** The targets that passed and the closed entries, in the shape reconcileTheme reads. */
  doc: ThemeTargetsDoc;
  /** One short sentence per target that was dropped. */
  refused: string[];
}

type AssetStrategy = Pick<ConfigDoc["config"]["strategy"], "direction" | "markets" | "universe">;

const EPSILON = 1e-9;
const short = (conditionId: string): string => (conditionId.length > 12 ? `${conditionId.slice(0, 10)}...` : conditionId);
const other = (side: 0 | 1): 0 | 1 => (side === 0 ? 1 : 0);

/**
 * `heldTokenIds` is optional: with it, a market that has no target takes the side
 * the wallet holds. The side only matters for a buy, and a buy always has a target.
 */
export function assetMarketsForCycle(doc: AssetMarketsTargetsDoc, strategy: AssetStrategy, heldTokenIds: readonly string[] = [], managedMarkets: readonly ThemeMarket[] = []): AssetCycleMarkets {
  const managed = strategy.universe === "managed";
  // A managed market's side is the outcome its target buys, so there is no long side to hold the direction against.
  const direction = managed ? "both" : strategy.direction ?? "both";
  const configured = managed ? managedMarkets : strategy.markets ?? [];
  const byCondition = new Map(configured.map((market) => [market.conditionId.toLowerCase(), market]));
  const sideOf = new Map<string, 0 | 1>();
  const refused: string[] = [];

  const targets = doc.targets.filter((target) => {
    const label = short(target.conditionId);
    const market = byCondition.get(target.conditionId.toLowerCase());
    if (!market) { refused.push(`${label}: ${managed ? "not confirmed on Polymarket" : "not one of the configured markets"}, refused.`); return false; }
    const bought = market.tokenIds.indexOf(target.tokenId);
    if (bought !== 0 && bought !== 1) { refused.push(`${label}: the target names a token that is not in this market, refused.`); return false; }
    if (direction === "long" && bought !== market.side) { refused.push(`${label}: the target buys the outcome a long-only key does not take, refused.`); return false; }
    if (direction === "short" && bought === market.side) { refused.push(`${label}: the target buys the outcome a short-only key does not take, refused.`); return false; }
    if (target.rule !== "q" || target.q === null) { refused.push(`${label}: Q has not forecast this market, refused.`); return false; }
    if (target.maxPrice < ASSET_MARKET_MIN_PRICE - EPSILON) { refused.push(`${label}: the limit ${target.maxPrice} is below ${ASSET_MARKET_MIN_PRICE}, refused.`); return false; }
    if (target.maxPrice > ASSET_MARKET_MAX_PRICE + EPSILON) { refused.push(`${label}: the limit ${target.maxPrice} is above ${ASSET_MARKET_MAX_PRICE}, refused.`); return false; }
    if (target.q - target.maxPrice < ASSET_MARKET_MIN_EDGE - EPSILON) { refused.push(`${label}: Q ${target.q} is not 5 points above the limit ${target.maxPrice}, refused.`); return false; }
    sideOf.set(market.conditionId.toLowerCase(), bought);
    return true;
  });

  const markets = configured.map((market): ThemeMarket => {
    const targeted = sideOf.get(market.conditionId.toLowerCase());
    const held = market.tokenIds.findIndex((tokenId) => heldTokenIds.includes(tokenId));
    const side = targeted ?? (held === 0 || held === 1 ? held : direction === "short" ? other(market.side) : market.side);
    return { ...market, side };
  });

  return { markets, doc: { v: doc.v, strategyId: THEME_STRATEGY_ID, asOf: doc.asOf, validUntil: doc.validUntil, mode: doc.mode, targets, closed: doc.closed }, refused };
}
