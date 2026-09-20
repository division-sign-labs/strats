// Every Polymarket bot runs the same loop. What differs is where the settings
// and the targets come from, and which markets the bot may trade: a theme bot
// trades the markets its creator chose, a team bot trades its team's games after
// the local check in team-markets.ts, and a single-asset bot trades its asset's
// markets after the local check in asset-markets.ts.
import { ASSET_MARKET_MIN_EDGE, ASSET_MARKET_MIN_PRICE, assetMarketsForCycle } from "./asset-markets.js";
import { fetchAssetMarketsTargets, fetchConfig, fetchTeamConfig, fetchTeamTargets, fetchThemeConfig, fetchThemeTargets, type FetchResult, type GatewayOptions } from "./client.js";
import { isManaged } from "./protocol/index.js";
import type { AssetMarketsTargetsDoc, ConfigDoc, TeamConfigDoc, TeamTargetsDoc, ThemeConfigDoc, ThemeMarket, ThemeTargetsDoc } from "./protocol/index.js";
import { isTwoVenueBot, type BotState } from "./state.js";
import { teamMarketsForCycle, themeView } from "./team-markets.js";

export interface CycleMarkets {
  /** The markets this cycle may trade. Anything outside the list is refused or left alone. */
  markets: ThemeMarket[];
  /** The targets in the shape reconcileTheme reads. */
  doc: ThemeTargetsDoc;
  /** Team only: games dropped by the local check, one short sentence each. */
  refused: string[];
  /** Tokens whose book is read whether or not they are held. A held token in one of `markets` always gets its book read. */
  quoteTokenIds: string[];
}

export type PolymarketConfigDoc = ThemeConfigDoc | TeamConfigDoc | ConfigDoc;
export type PolymarketTargetsDoc = ThemeTargetsDoc | TeamTargetsDoc | AssetMarketsTargetsDoc;

export interface PolymarketSource<C extends PolymarketConfigDoc = PolymarketConfigDoc, T extends PolymarketTargetsDoc = PolymarketTargetsDoc> {
  strategyId: "theme" | "team" | "stock-ls";
  /** The log prefix. */
  label: "theme" | "team" | "markets";
  fetchConfig(gateway: GatewayOptions): Promise<FetchResult<C>>;
  fetchTargets(gateway: GatewayOptions): Promise<FetchResult<T>>;
  /**
   * Without settings there is nothing to check a market against, so the list is empty and nothing is traded.
   * `managedMarkets` is read only for a managed key: the markets of this document, as confirmed on Polymarket.
   */
  marketsFor(config: C | undefined, targets: T, managedMarkets?: readonly ThemeMarket[]): CycleMarkets;
  /** Held against the live book when an order is about to be placed. */
  entryRule?: { minBuyPrice: number; minEdge: number };
}

export const THEME_SOURCE: PolymarketSource<ThemeConfigDoc, ThemeTargetsDoc> = {
  strategyId: "theme",
  label: "theme",
  fetchConfig: fetchThemeConfig,
  fetchTargets: fetchThemeTargets,
  marketsFor: (config, targets, managedMarkets = []) => ({
    markets: isManaged(config) ? [...managedMarkets] : config?.config.strategy.markets ?? [], doc: targets, refused: [],
    quoteTokenIds: [...targets.targets.map((t) => t.tokenId), ...targets.closed.map((c) => c.tokenId)],
  }),
};

export const TEAM_SOURCE: PolymarketSource<TeamConfigDoc, TeamTargetsDoc> = {
  strategyId: "team",
  label: "team",
  fetchConfig: fetchTeamConfig,
  fetchTargets: fetchTeamTargets,
  // A finished game lists both of its tokens as closed, and a finished game has no book, so only the targets are quoted up front.
  marketsFor: (config, targets) => ({
    ...(config ? teamMarketsForCycle(targets, config.config.strategy) : { markets: [], doc: themeView(targets), refused: [] }),
    quoteTokenIds: targets.targets.map((t) => t.tokenId),
  }),
};

/** The Polymarket side of a single-asset bot. The settings are the same document the perp reads. */
export const ASSET_SOURCE: PolymarketSource<ConfigDoc, AssetMarketsTargetsDoc> = {
  strategyId: "stock-ls",
  label: "markets",
  fetchConfig,
  fetchTargets: fetchAssetMarketsTargets,
  entryRule: { minBuyPrice: ASSET_MARKET_MIN_PRICE, minEdge: ASSET_MARKET_MIN_EDGE },
  marketsFor: (config, targets, managedMarkets = []) => ({
    ...assetMarketsForCycle(targets, config?.config.strategy ?? {}, [], managedMarkets),
    quoteTokenIds: [...targets.targets.map((t) => t.tokenId), ...targets.closed.map((c) => c.tokenId)],
  }),
};

export function sourceFor(bot: Pick<BotState, "strategyId" | "markets">): PolymarketSource {
  if (bot.strategyId === "team") return TEAM_SOURCE as PolymarketSource;
  if (bot.strategyId === "theme") return THEME_SOURCE as PolymarketSource;
  if (isTwoVenueBot(bot)) return ASSET_SOURCE as PolymarketSource;
  throw new Error("This bot does not trade on Polymarket.");
}
