// The local check for a team bot. A theme bot only ever trades the markets its
// creator chose; a team bot has no such list, so each cycle the games the server
// names are checked against the settings: the game must name the team, the side
// bought must be the one the chosen bet allows, and the price limit must not be
// above the creator's. What passes becomes the market list that the unchanged
// reconcileTheme function trades from. Pure: no I/O, no clock.
import { THEME_STRATEGY_ID, type TeamMarket, type TeamStrategy, type TeamTargetsDoc, type ThemeMarket, type ThemeTargetsDoc } from "./protocol/index.js";

export interface TeamCycleMarkets {
  /** The games that passed, in the shape reconcileTheme reads. `side` is the outcome a target may buy. */
  markets: ThemeMarket[];
  /** The same targets and closed entries, in the shape reconcileTheme reads. */
  doc: ThemeTargetsDoc;
  /** One short sentence per game that was dropped. */
  refused: string[];
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
const short = (conditionId: string): string => (conditionId.length > 12 ? `${conditionId.slice(0, 10)}...` : conditionId);
const isYesNo = (outcomes: readonly [string, string]): boolean => outcomes.some((o) => same(o, "yes")) && outcomes.some((o) => same(o, "no"));

/** Exact names only, never a substring: a game that cannot be tied to the team is not traded. */
function namesTeam(market: TeamMarket, team: TeamStrategy["team"]): boolean {
  if (isYesNo(market.outcomes)) {
    // "Will X win on DATE?": Yes is the team winning, and the question must say whose game it is.
    return same(market.outcomes[market.teamSide], "yes") && market.question.toLowerCase().includes(team.name.trim().toLowerCase());
  }
  const names = [team.name, team.alias].filter((name): name is string => typeof name === "string" && name.trim() !== "");
  return names.some((name) => same(market.outcomes[market.teamSide], name));
}

/** The outcome index the chosen bet may buy, or null when either side is allowed. */
function allowedSide(mode: TeamStrategy["mode"], teamSide: 0 | 1): 0 | 1 | null {
  if (mode === "follow") return null;
  return mode === "back" || mode === "back-favored" ? teamSide : teamSide === 0 ? 1 : 0;
}

/**
 * `heldTokenIds` is optional: with it, a game that has no target takes the side
 * the wallet holds. The side only matters for a buy, and a buy always has a target.
 */
export function teamMarketsForCycle(doc: TeamTargetsDoc, strategy: TeamStrategy, heldTokenIds: readonly string[] = []): TeamCycleMarkets {
  const markets: ThemeMarket[] = [];
  const refused: string[] = [];
  const capPrice = strategy.maxPriceCents / 100 + 1e-9;
  const targetOf = new Map(doc.targets.map((target) => [target.conditionId.toLowerCase(), target]));

  for (const game of doc.markets) {
    const label = short(game.conditionId);
    if (!namesTeam(game, strategy.team)) {
      refused.push(`${label}: does not name ${strategy.team.name}, refused.`);
      continue;
    }
    let side: 0 | 1 = game.teamSide;
    const target = targetOf.get(game.conditionId.toLowerCase());
    if (target) {
      const bought = game.tokenIds.indexOf(target.tokenId);
      const allowed = allowedSide(strategy.mode, game.teamSide);
      if (bought !== 0 && bought !== 1) { refused.push(`${label}: the target names a token that is not in this game, refused.`); continue; }
      if (allowed !== null && bought !== allowed) { refused.push(`${label}: the target buys the side your bet does not allow, refused.`); continue; }
      if (!(target.maxPrice <= capPrice)) { refused.push(`${label}: the target would pay up to ${target.maxPrice}, above your ${strategy.maxPriceCents}¢, refused.`); continue; }
      // A bet is placed before the game starts, so an entry deadline at or after the start is not one of ours.
      if (target.expiresAt === null || !(Date.parse(target.expiresAt) < Date.parse(game.gameStartTime))) { refused.push(`${label}: the target stays open after the game starts, refused.`); continue; }
      side = bought;
    } else {
      const held = game.tokenIds.findIndex((tokenId) => heldTokenIds.includes(tokenId));
      if (held === 0 || held === 1) side = held;
    }
    markets.push({ conditionId: game.conditionId, tokenIds: game.tokenIds, outcomes: game.outcomes, side, question: game.question, marketKey: null });
  }

  return { markets, doc: themeView(doc), refused };
}

/** reconcileTheme reads the targets, the closed list, the mode and the expiry. The games list stays behind. */
export function themeView(doc: TeamTargetsDoc): ThemeTargetsDoc {
  return { v: doc.v, strategyId: THEME_STRATEGY_ID, asOf: doc.asOf, validUntil: doc.validUntil, mode: doc.mode, targets: doc.targets, closed: doc.closed };
}

/** Counts for the status "Games" row. */
export function gameCounts(doc: TeamTargetsDoc): { upcoming: number; live: number; closed: number } {
  const count = (state: TeamMarket["state"]): number => doc.markets.filter((m) => m.state === state).length;
  return { upcoming: count("upcoming"), live: count("live"), closed: count("closed") };
}
