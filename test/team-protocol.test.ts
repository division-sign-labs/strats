import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverConfig, fetchConfigFor, fetchTeamTargets } from "../src/client.js";
import { parseConfig, parseTeamConfig, parseTeamTargets, parseThemeConfig, parseThemeTargets } from "../src/protocol/index.js";

const account = { positionPct: 10, token: { chainId: 8453, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, split: { buybackPct: 70, keepPct: 30 } };
const mets = { id: "114207", name: "New York Mets", alias: "Mets", abbreviation: "nym", league: "mlb", sport: "baseball" };
const strategy = { team: mets, mode: "back-favored", marginPts: 10, maxPriceCents: 85 };
const teamConfig = (over: Record<string, unknown> = {}, strategyOver: Record<string, unknown> = {}) => ({
  strategyId: "team", version: 2, updatedAt: "2026-09-19T00:00:00.000Z",
  config: { v: 1, strategyId: "team", strategy: { ...strategy, ...strategyOver }, account, ...over },
});

const game = { conditionId: "0xgame1", tokenIds: ["111", "222"], outcomes: ["Philadelphia Phillies", "New York Mets"], teamSide: 1, question: "Phillies vs. Mets", gameStartTime: "2026-09-19T20:05:00.000Z", state: "upcoming" };
const finished = { conditionId: "0xgame0", tokenIds: ["333", "444"], outcomes: ["New York Mets", "Atlanta Braves"], teamSide: 0, question: "Mets vs. Braves", gameStartTime: "2026-09-17T23:10:00.000Z", state: "closed" };
const target = { id: "0xgame1:1", venue: "polymarket", conditionId: "0xgame1", tokenId: "222", outcome: "New York Mets", question: "Phillies vs. Mets", maxPrice: 0.85, takeProfitPrice: 1, expiresAt: "2026-09-19T20:00:00.000Z", rule: "market", q: null, reason: "New York Mets leads by 16 points (58¢ to 42¢ for New York Mets). Buy New York Mets up to 85¢ before the game starts." };
const reason = "This game has finished and its market has closed. Sell or redeem what is held.";
const targets = (over: Record<string, unknown> = {}) => ({
  v: 1, strategyId: "team", asOf: "2026-09-19T12:00:00.000Z", validUntil: "2026-09-19T12:05:00.000Z", mode: "open",
  targets: [target],
  closed: [{ conditionId: "0xgame0", tokenId: "333", reason }, { conditionId: "0xgame0", tokenId: "444", reason }],
  markets: [game, finished],
  ...over,
});

describe("team config", () => {
  it("parses, reads an absent alias and abbreviation as null, and tolerates unknown fields", () => {
    const parsed = parseTeamConfig(teamConfig({ somethingNew: 1 }));
    assert.equal(parsed.ok, true);
    const { alias: _a, abbreviation: _b, ...bare } = mets;
    const without = parseTeamConfig(teamConfig({}, { team: bare }));
    assert.ok(without.ok);
    assert.equal(without.value.config.strategy.team.alias, null);
    assert.equal(without.value.config.strategy.team.abbreviation, null);
  });

  it("accepts each of the five bets and nothing else", () => {
    for (const mode of ["back", "against", "follow", "back-favored", "against-favored"]) assert.equal(parseTeamConfig(teamConfig({}, { mode })).ok, true, mode);
    assert.equal(parseTeamConfig(teamConfig({}, { mode: "fade" })).ok, false);
  });

  it("fails outside the bounds", () => {
    const bad = (over: Record<string, unknown>) => parseTeamConfig(teamConfig({}, over)).ok;
    assert.equal(bad({ marginPts: 41 }), false);
    assert.equal(bad({ marginPts: -1 }), false);
    assert.equal(bad({ marginPts: 2.5 }), false);
    assert.equal(bad({ maxPriceCents: 4 }), false);
    assert.equal(bad({ maxPriceCents: 96 }), false);
    assert.equal(bad({ team: { ...mets, league: "nba" } }), false);
    assert.equal(bad({ team: { ...mets, sport: "cricket" } }), false);
    assert.equal(bad({ team: { ...mets, name: "" } }), false);
    assert.equal(bad({ team: { ...mets, name: "x".repeat(81) } }), false);
    assert.equal(bad({ team: { ...mets, id: "" } }), false);
    assert.equal(bad({ marginPts: 40, maxPriceCents: 95 }), true);
    assert.equal(bad({ marginPts: 0, maxPriceCents: 5 }), true);
  });

  it("is not accepted as another strategy's config, and the reverse", () => {
    assert.equal(parseConfig(teamConfig()).ok, false);
    assert.equal(parseThemeConfig(teamConfig()).ok, false);
    assert.equal(parseTeamConfig({ ...teamConfig(), strategyId: "theme" }).ok, false);
    assert.equal(parseTeamConfig({ ...teamConfig(), config: { ...teamConfig().config, strategyId: "theme" } }).ok, false);
  });
});

describe("team targets", () => {
  it("parses, keeps both closed tokens of a finished game, and tolerates unknown fields", () => {
    const parsed = parseTeamTargets({ ...targets(), extra: true });
    assert.ok(parsed.ok);
    assert.equal(parsed.value.closed.length, 2);
    assert.equal(parsed.value.markets[0]!.teamSide, 1);
  });

  it("parses an empty document, which is what the off-season looks like", () => {
    assert.equal(parseTeamTargets(targets({ targets: [], closed: [], markets: [] })).ok, true);
  });

  it("reads a game state it does not know as upcoming, because the state is display only", () => {
    const parsed = parseTeamTargets(targets({ markets: [{ ...game, state: "postponed" }, finished] }));
    assert.ok(parsed.ok);
    assert.equal(parsed.value.markets[0]!.state, "upcoming");
  });

  it("is never accepted by a theme runner, and a theme document is never accepted by a team runner", () => {
    assert.equal(parseThemeTargets(targets()).ok, false);
    assert.equal(parseTeamTargets({ ...targets(), strategyId: "theme" }).ok, false);
    const { markets: _markets, ...noGames } = targets();
    assert.equal(parseTeamTargets(noGames).ok, false);
  });

  it("fails, so the runner holds, when a target has no entry deadline or follows the Q rule", () => {
    assert.equal(parseTeamTargets(targets({ targets: [{ ...target, expiresAt: null }] })).ok, false);
    assert.equal(parseTeamTargets(targets({ targets: [{ ...target, rule: "q", q: 0.7 }] })).ok, false);
  });

  it("fails when a target or a closed entry names a game or a token that is not listed", () => {
    assert.equal(parseTeamTargets(targets({ markets: [finished] })).ok, false);
    assert.equal(parseTeamTargets(targets({ targets: [{ ...target, tokenId: "999" }] })).ok, false);
    assert.equal(parseTeamTargets(targets({ closed: [{ conditionId: "0xgame0", tokenId: "999", reason }] })).ok, false);
    assert.equal(parseTeamTargets(targets({ closed: [{ conditionId: "0xother", tokenId: "333", reason }] })).ok, false);
  });

  it("fails on a game with one token twice, a game listed twice, or more than 60 games", () => {
    assert.equal(parseTeamTargets(targets({ markets: [{ ...game, tokenIds: ["222", "222"] }, finished] })).ok, false);
    assert.equal(parseTeamTargets(targets({ markets: [game, game, finished] })).ok, false);
    const many = Array.from({ length: 61 }, (_, i) => ({ ...game, conditionId: `0xg${i}`, tokenIds: [`a${i}`, `b${i}`] }));
    assert.equal(parseTeamTargets(targets({ targets: [], closed: [], markets: many })).ok, false);
  });

  it("keeps the theme identity rules: the id names the market, one target per market, never targeted and closed at once, validUntil after asOf", () => {
    assert.equal(parseTeamTargets(targets({ targets: [{ ...target, id: "0xother:1" }] })).ok, false);
    assert.equal(parseTeamTargets(targets({ targets: [target, { ...target, id: "0xgame1:0", tokenId: "111" }] })).ok, false);
    assert.equal(parseTeamTargets(targets({ closed: [{ conditionId: "0xgame1", tokenId: "222", reason }] })).ok, false);
    assert.equal(parseTeamTargets(targets({ validUntil: "2026-09-19T12:00:00.000Z" })).ok, false);
  });
});

const KEY = "qsk_test_0123456789abcdef";
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function stub(responses: Response[]): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    const next = responses.shift();
    if (!next) throw new Error("no more stubbed responses");
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}
const opts = (fetchImpl: typeof fetch) => ({ gatewayUrl: "https://gateway.example", apiKey: KEY, fetchImpl });
const forbidden = () => json(403, { error: "strategy_not_allowed" });

describe("discoverConfig", () => {
  it("asks for single asset, then theme, then team, moving on only after a 403", async () => {
    const { fetchImpl, urls } = stub([forbidden(), forbidden(), json(200, teamConfig())]);
    const found = await discoverConfig(opts(fetchImpl));
    assert.ok(found.ok);
    assert.equal(found.value.config.strategyId, "team");
    assert.deepEqual(urls.map((u) => u.split("/strategies/")[1]), ["stock-ls/config", "theme/config", "team/config"]);
  });

  it("stops at the first strategy that answers", async () => {
    const stockConfig = { strategyId: "stock-ls", version: 1, updatedAt: "2026-09-19T00:00:00.000Z", config: { v: 1, strategyId: "stock-ls", strategy: { assetKey: "crypto:btc" }, account } };
    const { fetchImpl, urls } = stub([json(200, stockConfig)]);
    assert.ok((await discoverConfig(opts(fetchImpl))).ok);
    assert.equal(urls.length, 1);
  });

  it("does not try the next strategy after a 401, a 404 or a 503", async () => {
    for (const status of [401, 404, 503]) {
      const { fetchImpl, urls } = stub([forbidden(), json(status, { error: status === 404 ? "not_configured" : "x" })]);
      const found = await discoverConfig(opts(fetchImpl));
      assert.equal(found.ok, false);
      assert.equal(urls.length, 2, String(status));
    }
  });

  it("reports the last 403 when the key belongs to none of the three", async () => {
    const { fetchImpl, urls } = stub([forbidden(), forbidden(), forbidden()]);
    const found = await discoverConfig(opts(fetchImpl));
    assert.ok(!found.ok && found.kind === "auth" && found.status === 403);
    assert.equal(urls.length, 3);
  });
});

describe("team client", () => {
  it("reads the settings of a known strategy from its own path", async () => {
    const { fetchImpl, urls } = stub([json(200, teamConfig())]);
    assert.ok((await fetchConfigFor("team", opts(fetchImpl))).ok);
    assert.equal(urls[0], "https://gateway.example/api/v1/strategies/team/config");
  });

  it("reads the targets, and turns a 503 or a document that does not parse into a failure the runner holds on", async () => {
    const good = stub([json(200, targets())]);
    assert.ok((await fetchTeamTargets(opts(good.fetchImpl))).ok);
    assert.equal(good.urls[0], "https://gateway.example/api/v1/strategies/team/targets");
    const down = await fetchTeamTargets(opts(stub([json(503, { error: "target_unavailable" })]).fetchImpl));
    assert.ok(!down.ok && down.kind === "unavailable");
    const wrong = await fetchTeamTargets(opts(stub([json(200, { ...targets(), strategyId: "theme" })]).fetchImpl));
    assert.ok(!wrong.ok && wrong.kind === "invalid");
  });
});
