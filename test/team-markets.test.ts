import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TEAM_SOURCE, THEME_SOURCE, sourceFor } from "../src/polymarket-source.js";
import { parseTeamTargets, type TeamConfigDoc, type TeamStrategy, type TeamTargetsDoc, type ThemeTarget } from "../src/protocol/index.js";
import { reconcileTheme, type ThemeReconcileInput } from "../src/reconcile-theme.js";
import { gameCounts, teamMarketsForCycle } from "../src/team-markets.js";

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const START = "2026-09-19T20:05:00.000Z";
const DEADLINE = "2026-09-19T20:00:00.000Z";
const reason = "This game has finished and its market has closed. Sell or redeem what is held.";

const mets: TeamStrategy["team"] = { id: "114207", name: "New York Mets", alias: "Mets", abbreviation: "nym", league: "mlb", sport: "baseball" };
const strategy = (over: Partial<TeamStrategy> = {}): TeamStrategy => ({ team: mets, mode: "back", marginPts: 10, maxPriceCents: 85, ...over });

type Game = TeamTargetsDoc["markets"][number];
const upcoming = (over: Partial<Game> = {}): Game => ({ conditionId: "0xgame1", tokenIds: ["phi1", "nym1"], outcomes: ["Philadelphia Phillies", "New York Mets"], teamSide: 1, question: "Phillies vs. Mets", gameStartTime: START, state: "upcoming", ...over });
const live: Game = { conditionId: "0xgame2", tokenIds: ["nym2", "atl2"], outcomes: ["New York Mets", "Atlanta Braves"], teamSide: 0, question: "Mets vs. Braves", gameStartTime: "2026-09-19T11:00:00.000Z", state: "live" };
const finished: Game = { conditionId: "0xgame3", tokenIds: ["nym3", "mia3"], outcomes: ["New York Mets", "Miami Marlins"], teamSide: 0, question: "Mets vs. Marlins", gameStartTime: "2026-09-17T23:10:00.000Z", state: "closed" };
const buy = (game: Game, index: 0 | 1, over: Partial<ThemeTarget> = {}): ThemeTarget => ({
  id: `${game.conditionId}:${index}`, venue: "polymarket", conditionId: game.conditionId, tokenId: game.tokenIds[index], outcome: game.outcomes[index], question: game.question,
  maxPrice: 0.85, takeProfitPrice: 1, expiresAt: DEADLINE, rule: "market", q: null, reason: "Priced at 58¢. Buy up to 85¢ before the game starts.", ...over,
});
function doc(over: Partial<TeamTargetsDoc> = {}): TeamTargetsDoc {
  const parsed = parseTeamTargets({
    v: 1, strategyId: "team", asOf: new Date(NOW - 60_000).toISOString(), validUntil: new Date(NOW + 240_000).toISOString(), mode: "open",
    targets: [buy(upcoming(), 1)],
    closed: [{ conditionId: finished.conditionId, tokenId: "nym3", reason }, { conditionId: finished.conditionId, tokenId: "mia3", reason }],
    markets: [upcoming(), live, finished],
    ...over,
  });
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.value;
}

describe("teamMarketsForCycle", () => {
  it("turns each game that names the team into a market, with the bought side on a targeted game and the team's side elsewhere", () => {
    const result = teamMarketsForCycle(doc(), strategy());
    assert.deepEqual(result.refused, []);
    assert.deepEqual(result.markets.map((m) => [m.conditionId, m.side, m.marketKey]), [["0xgame1", 1, null], ["0xgame2", 0, null], ["0xgame3", 0, null]]);
    assert.equal(result.doc.strategyId, "theme");
    assert.equal(result.doc.targets.length, 1);
    assert.equal(result.doc.closed.length, 2);
    assert.equal("markets" in result.doc, false);
  });

  it("matches the alias, ignores case and spaces, and never matches part of a name", () => {
    const nfl = upcoming({ outcomes: ["Panthers", " mets "] });
    assert.equal(teamMarketsForCycle(doc({ targets: [], closed: [], markets: [nfl] }), strategy()).markets.length, 1);
    const partial = upcoming({ outcomes: ["Philadelphia Phillies", "New York Mets II"] });
    const result = teamMarketsForCycle(doc({ targets: [], closed: [], markets: [partial] }), strategy());
    assert.deepEqual(result.markets, []);
    assert.match(result.refused[0]!, /0xgame1: does not name New York Mets, refused\./);
  });

  it("refuses a game whose team side is the other team", () => {
    const wrongSide = upcoming({ teamSide: 0 });
    const result = teamMarketsForCycle(doc({ targets: [], closed: [], markets: [wrongSide] }), strategy());
    assert.deepEqual(result.markets, []);
    assert.equal(result.refused.length, 1);
  });

  it("accepts a soccer Yes/No market only when Yes is the team's side and the question names the team", () => {
    const city: TeamStrategy["team"] = { id: "9", name: "Manchester City FC", alias: "Man City", abbreviation: "mac", league: "epl", sport: "soccer" };
    const soccer = upcoming({ conditionId: "0xepl1", tokenIds: ["yes", "no"], outcomes: ["Yes", "No"], teamSide: 0, question: "Will Manchester City FC win on 2026-09-20?" });
    const ok = teamMarketsForCycle(doc({ targets: [buy(soccer, 1)], closed: [], markets: [soccer] }), strategy({ team: city, mode: "against" }));
    assert.deepEqual(ok.refused, []);
    assert.equal(ok.markets[0]!.side, 1);
    assert.equal(teamMarketsForCycle(doc({ targets: [], closed: [], markets: [{ ...soccer, teamSide: 1 }] }), strategy({ team: city })).markets.length, 0);
    const draw = { ...soccer, question: "Will Manchester City FC vs. Arsenal FC end in a draw?".replace("Manchester City FC", "Man City") };
    assert.equal(teamMarketsForCycle(doc({ targets: [], closed: [], markets: [draw] }), strategy({ team: city })).markets.length, 0);
    const opponent = { ...soccer, question: "Will Arsenal FC win on 2026-09-20?" };
    assert.equal(teamMarketsForCycle(doc({ targets: [], closed: [], markets: [opponent] }), strategy({ team: city })).markets.length, 0);
  });

  it("allows only the team's side for back and back-favored", () => {
    for (const mode of ["back", "back-favored"] as const) {
      assert.equal(teamMarketsForCycle(doc(), strategy({ mode })).markets.length, 3, mode);
      const other = teamMarketsForCycle(doc({ targets: [buy(upcoming(), 0)] }), strategy({ mode }));
      assert.deepEqual(other.markets.map((m) => m.conditionId), ["0xgame2", "0xgame3"], mode);
      assert.match(other.refused[0]!, /buys the side your bet does not allow/);
    }
  });

  it("allows only the other side for against and against-favored", () => {
    for (const mode of ["against", "against-favored"] as const) {
      const other = teamMarketsForCycle(doc({ targets: [buy(upcoming(), 0)] }), strategy({ mode }));
      assert.equal(other.markets[0]!.side, 0, mode);
      assert.deepEqual(other.refused, [], mode);
      assert.equal(teamMarketsForCycle(doc(), strategy({ mode })).markets.length, 2, mode);
    }
  });

  it("allows either side for follow", () => {
    assert.equal(teamMarketsForCycle(doc(), strategy({ mode: "follow" })).markets[0]!.side, 1);
    assert.equal(teamMarketsForCycle(doc({ targets: [buy(upcoming(), 0)] }), strategy({ mode: "follow" })).markets[0]!.side, 0);
  });

  it("refuses a target that would pay more than the creator's limit, and accepts one at or under it", () => {
    const over = teamMarketsForCycle(doc({ targets: [buy(upcoming(), 1, { maxPrice: 0.851 })] }), strategy());
    assert.equal(over.markets.length, 2);
    assert.match(over.refused[0]!, /above your 85¢/);
    assert.equal(teamMarketsForCycle(doc({ targets: [buy(upcoming(), 1, { maxPrice: 0.85 })] }), strategy()).markets.length, 3);
    assert.equal(teamMarketsForCycle(doc({ targets: [buy(upcoming(), 1, { maxPrice: 0.6 })] }), strategy()).markets.length, 3);
  });

  it("refuses a target whose entry deadline is not before the game starts", () => {
    const late = teamMarketsForCycle(doc({ targets: [buy(upcoming(), 1, { expiresAt: START })] }), strategy());
    assert.equal(late.markets.length, 2);
    assert.match(late.refused[0]!, /after the game starts/);
  });

  it("takes the held side for a game without a target when the holdings are given", () => {
    const result = teamMarketsForCycle(doc({ targets: [] }), strategy({ mode: "follow" }), ["atl2"]);
    assert.equal(result.markets.find((m) => m.conditionId === "0xgame2")!.side, 1);
  });

  it("counts the games for the status row", () => {
    assert.deepEqual(gameCounts(doc()), { upcoming: 1, live: 1, closed: 1 });
  });
});

describe("a team document through reconcileTheme", () => {
  const input = (d: TeamTargetsDoc, s: TeamStrategy, over: Partial<ThemeReconcileInput> = {}): ThemeReconcileInput => {
    const cycle = teamMarketsForCycle(d, s);
    return {
      targets: { ok: true, doc: cycle.doc }, now: NOW, markets: cycle.markets,
      holdings: [], quotes: { nym1: { bid: 0.57, ask: 0.58 }, phi1: { bid: 0.41, ask: 0.42 }, nym2: { bid: 0.7, ask: 0.72 } },
      collateralUsd: 1000, equityUsd: 1000, exposureUsd: 0, positionPct: 10, ceilingPct: 10,
      blockedTargetIds: [], redeemedConditionIds: [], pendingTokenIds: [], ...over,
    };
  };

  it("buys the target, keeps the live game and redeems the finished one", () => {
    const d = reconcileTheme(input(doc(), strategy(), {
      holdings: [{ tokenId: "nym2", conditionId: "0xgame2", size: 100, redeemable: false }, { tokenId: "nym3", conditionId: "0xgame3", size: 50, redeemable: true }],
      exposureUsd: 120,
    }));
    assert.equal(d.hold, null);
    assert.deepEqual(d.actions.map((a) => [a.kind, a.tokenId]), [["redeem", "nym3"], ["buy", "nym1"]]);
    const bought = d.actions[1]!;
    assert.ok(bought.kind === "buy" && bought.limitPx === 0.58 && bought.maxPrice === 0.85 && bought.budgetUsd === 100);
    // The live game is named by neither list, so its position is left exactly as it is.
    assert.equal(d.actions.some((a) => a.tokenId === "nym2"), false);
  });

  it("redeems whichever side of a finished game is held, because both tokens are listed", () => {
    const d = reconcileTheme(input(doc({ targets: [] }), strategy({ mode: "follow" }), { holdings: [{ tokenId: "mia3", conditionId: "0xgame3", size: 40, redeemable: true }] }));
    assert.deepEqual(d.actions.map((a) => [a.kind, a.tokenId]), [["redeem", "mia3"]]);
  });

  it("sells a finished game at the bid when it cannot be redeemed yet", () => {
    const d = reconcileTheme(input(doc({ targets: [] }), strategy(), { holdings: [{ tokenId: "nym3", conditionId: "0xgame3", size: 40, redeemable: false }], quotes: { nym3: { bid: 0.99, ask: 1 } } }));
    assert.deepEqual(d.actions.map((a) => a.kind), ["sell"]);
  });

  it("keeps a game that is already held and buys no more of it", () => {
    const d = reconcileTheme(input(doc(), strategy(), { holdings: [{ tokenId: "nym1", conditionId: "0xgame1", size: 100, redeemable: false }] }));
    assert.deepEqual(d.actions, []);
    assert.equal(d.kept, 1);
  });

  it("never sells before the final whistle: the take-profit price of 1 is not reached by a bid of 0.99", () => {
    const d = reconcileTheme(input(doc(), strategy(), { holdings: [{ tokenId: "nym1", conditionId: "0xgame1", size: 100, redeemable: false }], quotes: { nym1: { bid: 0.99, ask: 0.995 } } }));
    assert.deepEqual(d.actions, []);
  });

  it("does not buy the other side of a game it already holds when the market flips under follow", () => {
    const d = reconcileTheme(input(doc({ targets: [buy(upcoming(), 0)] }), strategy({ mode: "follow" }), { holdings: [{ tokenId: "nym1", conditionId: "0xgame1", size: 100, redeemable: false }] }));
    assert.deepEqual(d.actions, []);
  });

  it("refuses a target the local check dropped, and buys nothing", () => {
    const d = reconcileTheme(input(doc({ targets: [buy(upcoming(), 0)] }), strategy({ mode: "back" })));
    assert.deepEqual(d.actions, []);
    assert.match(d.notes.join(" "), /not one of the configured markets, refused/);
  });

  it("does not buy above the ask limit, after the entry deadline, or in reduce-only mode", () => {
    assert.deepEqual(reconcileTheme(input(doc(), strategy(), { quotes: { nym1: { bid: 0.85, ask: 0.86 } } })).actions, []);
    assert.deepEqual(reconcileTheme(input(doc(), strategy(), { now: Date.parse(DEADLINE) })).actions, []);
    assert.deepEqual(reconcileTheme(input(doc({ mode: "reduce-only" }), strategy())).actions, []);
  });

  it("holds on a stale document", () => {
    const d = reconcileTheme(input(doc(), strategy(), { now: NOW + 10 * 60_000 }));
    assert.match(d.hold ?? "", /expired/);
  });
});

describe("the Polymarket source of a bot", () => {
  const config = { strategyId: "team", version: 1, updatedAt: "2026-09-19T00:00:00.000Z", config: { v: 1, strategyId: "team", strategy: strategy(), account: { positionPct: 10, token: { chainId: 8453, address: "0xabc" }, split: { buybackPct: 70, keepPct: 30 } } } } as TeamConfigDoc;

  it("is chosen by the strategy, and a single-asset bot has none", () => {
    assert.equal(sourceFor({ strategyId: "team" }).label, "team");
    assert.equal(sourceFor({ strategyId: "theme" }).label, "theme");
    assert.throws(() => sourceFor({ strategyId: "stock-ls" }));
  });

  it("gives a team bot no markets at all while its settings cannot be read, so nothing is bought, sold or redeemed", () => {
    const blind = TEAM_SOURCE.marketsFor(undefined, doc());
    assert.deepEqual(blind.markets, []);
    assert.equal(blind.doc.targets.length, 1);
    const seeing = TEAM_SOURCE.marketsFor(config, doc());
    assert.equal(seeing.markets.length, 3);
    // Finished games have no book, so only the targets are quoted up front.
    assert.deepEqual(seeing.quoteTokenIds, ["nym1"]);
  });

  it("leaves a theme bot's markets and quotes exactly as they were", () => {
    const market = { conditionId: "0xabc", tokenIds: ["111", "222"] as [string, string], outcomes: ["Yes", "No"] as [string, string], side: 0 as const, question: "Will it happen?", marketKey: null };
    const themeConfig = { strategyId: "theme" as const, version: 1, updatedAt: "2026-09-19T00:00:00.000Z", config: { v: 1 as const, strategyId: "theme" as const, strategy: { thesis: "A thesis", markets: [market] }, account: config.config.account } };
    const themeDoc = { v: 1 as const, strategyId: "theme" as const, asOf: "2026-09-19T12:00:00.000Z", validUntil: "2026-09-19T12:05:00.000Z", mode: "open" as const, targets: [], closed: [{ conditionId: "0xdef", tokenId: "333", reason: "Resolved." }] };
    const result = THEME_SOURCE.marketsFor(themeConfig, themeDoc);
    assert.deepEqual(result.markets, [market]);
    assert.equal(result.doc, themeDoc);
    assert.deepEqual(result.quoteTokenIds, ["333"]);
    assert.deepEqual(THEME_SOURCE.marketsFor(undefined, themeDoc).markets, []);
  });
});
