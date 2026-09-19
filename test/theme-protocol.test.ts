import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReportSchema, parseConfig, parseThemeConfig, parseThemeTargets } from "../src/protocol/index.js";

const account = { positionPct: 10, token: { chainId: 8453, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, split: { buybackPct: 70, keepPct: 30 } };
const marketDoc = { conditionId: "0xabc", tokenIds: ["111", "222"], outcomes: ["Yes", "No"], side: 0, question: "Will it happen?", marketKey: null };
const themeConfig = (over: Record<string, unknown> = {}) => ({
  strategyId: "theme", version: 3, updatedAt: "2026-09-19T00:00:00.000Z",
  config: { v: 1, strategyId: "theme", strategy: { thesis: "AI capex keeps growing", markets: [marketDoc] }, account, ...over },
});
const targets = (over: Record<string, unknown> = {}) => ({
  v: 1, strategyId: "theme", asOf: "2026-09-19T12:00:00.000Z", validUntil: "2026-09-19T12:05:00.000Z", mode: "open",
  targets: [{ id: "0xabc:0", venue: "polymarket", conditionId: "0xabc", tokenId: "111", outcome: "Yes", question: "Will it happen?", maxPrice: 0.6, takeProfitPrice: 0.9, expiresAt: null, rule: "q", q: 0.7, reason: "Q is above the market." }],
  closed: [{ conditionId: "0xdef", tokenId: "333", reason: "Resolved." }],
  ...over,
});

describe("theme config", () => {
  it("parses, with and without a profile, and tolerates unknown fields", () => {
    assert.equal(parseThemeConfig(themeConfig()).ok, true);
    const withProfile = parseThemeConfig(themeConfig({ profile: { name: "My fund", imageUrl: null, listed: true }, somethingNew: 1 }));
    assert.equal(withProfile.ok, true);
    if (withProfile.ok) assert.equal(withProfile.value.config.profile?.name, "My fund");
  });

  it("drops a profile it cannot read instead of failing the settings, because the profile is display only", () => {
    const parsed = parseThemeConfig(themeConfig({ profile: { name: "x".repeat(200), imageUrl: 7 } }));
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.value.config.profile, undefined);
    const stock = parseConfig({ strategyId: "stock-ls", version: 1, updatedAt: "2026-09-19T00:00:00.000Z", config: { v: 1, strategyId: "stock-ls", strategy: { assetKey: "NVDA" }, account, profile: "nonsense" } });
    assert.equal(stock.ok, true);
  });

  it("fails on a missing thesis, no markets, too many markets, a bad side, or a duplicate market", () => {
    const bad = (strategy: unknown) => parseThemeConfig({ ...themeConfig(), config: { ...themeConfig().config, strategy } }).ok;
    assert.equal(bad({ markets: [marketDoc] }), false);
    assert.equal(bad({ thesis: "ok thesis", markets: [] }), false);
    assert.equal(bad({ thesis: "ok thesis", markets: Array.from({ length: 41 }, (_, i) => ({ ...marketDoc, conditionId: `0x${i}` })) }), false);
    assert.equal(bad({ thesis: "ok thesis", markets: [{ ...marketDoc, side: 2 }] }), false);
    assert.equal(bad({ thesis: "ok thesis", markets: [marketDoc, marketDoc] }), false);
    assert.equal(bad({ thesis: "ok thesis", markets: [{ ...marketDoc, tokenIds: ["111", "111"] }] }), false);
  });

  it("is not accepted as a single-asset config, and the reverse", () => {
    assert.equal(parseConfig(themeConfig()).ok, false);
    assert.equal(parseThemeConfig({ strategyId: "stock-ls", version: 1, updatedAt: "2026-09-19T00:00:00.000Z", config: { v: 1, strategyId: "stock-ls", strategy: { assetKey: "NVDA" }, account } }).ok, false);
  });

  it("still parses a single-asset config that now carries direction and profile", () => {
    const parsed = parseConfig({ strategyId: "stock-ls", version: 1, updatedAt: "2026-09-19T00:00:00.000Z", config: { v: 1, strategyId: "stock-ls", strategy: { assetKey: "NVDA", direction: "long" }, account, profile: { name: "N", imageUrl: "https://example.com/a.png", listed: false } } });
    assert.equal(parsed.ok, true);
  });
});

describe("theme targets", () => {
  it("parses and tolerates unknown fields", () => {
    const parsed = parseThemeTargets({ ...targets(), extra: true, targets: [{ ...targets().targets[0], extra: 1 }] });
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.value.targets[0]!.maxPrice, 0.6);
  });

  it("accepts empty lists", () => {
    assert.equal(parseThemeTargets(targets({ targets: [], closed: [] })).ok, true);
  });

  for (const field of ["v", "strategyId", "asOf", "validUntil", "mode", "targets", "closed"]) {
    it(`fails when ${field} is missing`, () => {
      const doc = targets() as Record<string, unknown>;
      delete doc[field];
      assert.equal(parseThemeTargets(doc).ok, false);
    });
  }

  for (const field of ["id", "venue", "conditionId", "tokenId", "outcome", "question", "maxPrice", "takeProfitPrice", "expiresAt", "rule", "q", "reason"]) {
    it(`fails when a target has no ${field}`, () => {
      const t = { ...targets().targets[0] } as Record<string, unknown>;
      delete t[field];
      assert.equal(parseThemeTargets(targets({ targets: [t] })).ok, false);
    });
  }

  it("fails on a price outside 0 to 1, an unknown venue, mode or rule", () => {
    const one = (over: Record<string, unknown>) => parseThemeTargets(targets({ targets: [{ ...targets().targets[0], ...over }] })).ok;
    assert.equal(one({ maxPrice: 1.2 }), false);
    assert.equal(one({ takeProfitPrice: -0.1 }), false);
    assert.equal(one({ venue: "kalshi" }), false);
    assert.equal(one({ rule: "vibes" }), false);
    assert.equal(parseThemeTargets(targets({ mode: "close-all" })).ok, false);
  });

  it("fails when an id does not name its market, a market is listed twice, or is both targeted and closed", () => {
    const t = targets().targets[0]!;
    assert.equal(parseThemeTargets(targets({ targets: [{ ...t, id: "0xother:0" }] })).ok, false);
    assert.equal(parseThemeTargets(targets({ targets: [t, { ...t, tokenId: "222", id: "0xabc:1" }] })).ok, false);
    assert.equal(parseThemeTargets(targets({ closed: [{ conditionId: "0xabc", tokenId: "111", reason: "x" }] })).ok, false);
  });

  it("fails when validUntil is not after asOf", () => {
    assert.equal(parseThemeTargets(targets({ validUntil: "2026-09-19T12:00:00.000Z" })).ok, false);
  });
});

describe("report", () => {
  it("has exactly the agreed fields and no room for an address", () => {
    assert.deepEqual(Object.keys(ReportSchema.shape).sort(), ["at", "boughtBackUsd", "equityUsd", "lastAction", "netDepositsUsd", "openPositions", "profitUsd", "v", "venue", "volumeUsd"]);
  });
});
