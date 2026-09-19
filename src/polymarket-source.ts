// A theme bot and a team bot run the same Polymarket loop. What differs is where
// the settings and the targets come from, and which markets the bot may trade:
// a theme bot trades the markets its creator chose, a team bot trades its
// team's games after the local check in team-markets.ts.
import { fetchTeamConfig, fetchTeamTargets, fetchThemeConfig, fetchThemeTargets, type FetchResult, type GatewayOptions } from "./client.js";
import type { TeamConfigDoc, TeamTargetsDoc, ThemeConfigDoc, ThemeMarket, ThemeTargetsDoc } from "./protocol/index.js";
import type { BotState } from "./state.js";
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

export interface PolymarketSource<C extends ThemeConfigDoc | TeamConfigDoc = ThemeConfigDoc | TeamConfigDoc, T extends ThemeTargetsDoc | TeamTargetsDoc = ThemeTargetsDoc | TeamTargetsDoc> {
  strategyId: "theme" | "team";
  /** The log prefix. */
  label: "theme" | "team";
  fetchConfig(gateway: GatewayOptions): Promise<FetchResult<C>>;
  fetchTargets(gateway: GatewayOptions): Promise<FetchResult<T>>;
  /** Without settings there is nothing to check a market against, so the list is empty and nothing is traded. */
  marketsFor(config: C | undefined, targets: T): CycleMarkets;
}

export const THEME_SOURCE: PolymarketSource<ThemeConfigDoc, ThemeTargetsDoc> = {
  strategyId: "theme",
  label: "theme",
  fetchConfig: fetchThemeConfig,
  fetchTargets: fetchThemeTargets,
  marketsFor: (config, targets) => ({
    markets: config?.config.strategy.markets ?? [], doc: targets, refused: [],
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

export function sourceFor(bot: Pick<BotState, "strategyId">): PolymarketSource {
  if (bot.strategyId === "team") return TEAM_SOURCE as PolymarketSource;
  if (bot.strategyId === "theme") return THEME_SOURCE as PolymarketSource;
  throw new Error("This bot does not trade on Polymarket.");
}
