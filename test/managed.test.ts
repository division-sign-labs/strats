// 0.5.1. A managed key (strategy.universe: "managed") names no markets: the server
// chooses them, and the runner trades any market a valid targets document names
// once Polymarket itself confirms the token belongs to it. Legacy keys are unchanged.
// Also here: the money-review fixes that are not about the buyback machine.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ASSET_MARKET_MIN_EDGE, ASSET_MARKET_MIN_PRICE, assetMarketsForCycle } from "../src/asset-markets.js";
import { guardPartWayBuyback, type FundGuardPorts } from "../src/commands/fund.js";
import { describeConfig } from "../src/commands/init.js";
import { readCycle } from "../src/commands/run-theme.js";
import { managedMarketsForCycle, type MarketFacts } from "../src/managed-markets.js";
import { ASSET_SOURCE, THEME_SOURCE, type PolymarketSource } from "../src/polymarket-source.js";
import { isManaged, parseAssetMarketsTargets, parseConfig, parseThemeConfig, parseThemeTargets, tradesMarkets, type AssetMarketsTargetsDoc, type ConfigDoc, type ThemeConfigDoc, type ThemeMarket, type ThemeTargetsDoc } from "../src/protocol/index.js";
import { reconcileTheme, type ThemeReconcileInput } from "../src/reconcile-theme.js";
import { autoBuybackAvailable } from "../src/state.js";
import type { PolymarketSnapshot } from "../src/venue-polymarket.js";

const account = { positionPct: 10, token: { chainId: 8453, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, split: { buybackPct: 70, keepPct: 30 } };
const marketDoc = { conditionId: "0xabc", tokenIds: ["111", "222"], outcomes: ["Yes", "No"], side: 0, question: "Will it happen?", marketKey: null };
const stock = (strategy: Record<string, unknown>) => ({ strategyId: "stock-ls", version: 2, updatedAt: "2026-09-19T00:00:00.000Z", config: { v: 1, strategyId: "stock-ls", strategy, account } });
const theme = (strategy: Record<string, unknown>) => ({ strategyId: "theme", version: 2, updatedAt: "2026-09-19T00:00:00.000Z", config: { v: 1, strategyId: "theme", strategy, account } });
const value = <T>(parsed: { ok: true; value: T } | { ok: false; reason: string }): T => {
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
  return (parsed as { ok: true; value: T }).value;
};
const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const target = (over: Record<string, unknown> = {}) => ({ id: "0xabc:0", venue: "polymarket", conditionId: "0xabc", tokenId: "111", outcome: "Yes", question: "Will NVDA close above $200?", maxPrice: 0.75, takeProfitPrice: 0.99, expiresAt: null, rule: "q", q: 0.8, reason: "Q 80%, market 72%.", ...over });
const docOf = (strategyId: "theme" | "stock-ls", over: Record<string, unknown> = {}) => ({ v: 1, strategyId, asOf: "2026-09-19T12:00:00.000Z", validUntil: "2026-09-19T12:05:00.000Z", mode: "open", targets: [target()], closed: [], ...over });
const FACTS = new Map<string, MarketFacts>([
  ["111", { conditionId: "0xABC", tokens: [{ tokenId: "111", outcome: "Yes" }, { tokenId: "222", outcome: "No" }] }],
  ["222", { conditionId: "0xabc", tokens: [{ tokenId: "111", outcome: "Yes" }, { tokenId: "222", outcome: "No" }] }],
  ["999", { conditionId: "0xold", tokens: [{ tokenId: "998", outcome: "Yes" }, { tokenId: "999", outcome: "No" }] }],
]);
const wallet = (over: Partial<ThemeReconcileInput> = {}): Omit<ThemeReconcileInput, "targets" | "markets"> => ({
  now: NOW, holdings: [], quotes: { "111": { bid: 0.7, ask: 0.72 } }, collateralUsd: 1000, equityUsd: 1000, exposureUsd: 0, positionPct: 10, ceilingPct: 50,
  blockedTargetIds: [], redeemedConditionIds: [], pendingTokenIds: [], ...over,
});

describe("the config of a managed key", () => {
  it("is accepted for a theme with no markets, and for a single asset, which then trades two venues", () => {
    const themed = value(parseThemeConfig(theme({ thesis: "AI capex keeps growing", universe: "managed" })));
    assert.equal(isManaged(themed), true);
    const asset = value(parseConfig(stock({ assetKey: "NVDA", direction: "both", universe: "managed" })));
    assert.equal(isManaged(asset), true);
    assert.equal(tradesMarkets(asset), true);
    assert.ok(describeConfig(asset).some((line) => /Markets\s+on Polymarket, chosen by Q/.test(line)));
    assert.ok(describeConfig(themed).some((line) => /Markets\s+chosen by Q/.test(line)));
  });

  it("refuses markets together with universe, and a theme with neither", () => {
    assert.equal(parseThemeConfig(theme({ thesis: "AI capex keeps growing", universe: "managed", markets: [marketDoc] })).ok, false);
    assert.equal(parseConfig(stock({ assetKey: "NVDA", universe: "managed", markets: [marketDoc] })).ok, false);
    assert.equal(parseThemeConfig(theme({ thesis: "AI capex keeps growing" })).ok, false);
    assert.equal(parseConfig(stock({ assetKey: "NVDA", universe: "other" })).ok, false);
  });

  it("leaves legacy keys as they were: a list is a list, and no list and no universe is a perp-only key", () => {
    const legacy = value(parseThemeConfig(theme({ thesis: "AI capex keeps growing", markets: [marketDoc] })));
    assert.equal(isManaged(legacy), false);
    const perpOnly = value(parseConfig(stock({ assetKey: "NVDA" })));
    assert.equal(isManaged(perpOnly), false);
    assert.equal(tradesMarkets(perpOnly), false);
    assert.equal(tradesMarkets(value(parseConfig(stock({ assetKey: "NVDA", markets: [marketDoc] })))), true);
  });
});

describe("the markets of a managed key", () => {
  it("are whatever the document names, once Polymarket confirms the token belongs to the named market", () => {
    const doc = value(parseThemeTargets(docOf("theme")));
    const { markets, refused } = managedMarketsForCycle(doc, FACTS);
    assert.deepEqual(refused, []);
    assert.deepEqual(markets, [{ conditionId: "0xabc", tokenIds: ["111", "222"], outcomes: ["Yes", "No"], side: 0, question: "Will NVDA close above $200?", marketKey: null }]);
  });

  it("refuse a market Polymarket cannot confirm, or lists under another condition, and nothing is bought there", () => {
    const doc = value(parseThemeTargets(docOf("theme", { targets: [target(), target({ id: "0xzzz:0", conditionId: "0xzzz", tokenId: "555" }), target({ id: "0xother:1", conditionId: "0xother", tokenId: "222" })] })));
    const { markets, refused } = managedMarketsForCycle(doc, FACTS);
    assert.equal(markets.length, 1);
    assert.equal(refused.length, 2);
    assert.match(refused[0]!, /could not confirm/);
    assert.match(refused[1]!, /under another market/);
    const decision = reconcileTheme({ ...wallet({ quotes: { "111": { bid: 0.5, ask: 0.55 }, "555": { bid: 0.5, ask: 0.55 }, "222": { bid: 0.5, ask: 0.55 } } }), targets: { ok: true, doc }, markets });
    assert.deepEqual(decision.actions.filter((a) => a.kind === "buy").map((a) => a.tokenId), ["111"]);
  });

  it("include what the wallet holds, so a market the list dropped is still sold or redeemed when the document says it closed", () => {
    const doc = value(parseThemeTargets(docOf("theme", { targets: [], closed: [{ conditionId: "0xold", tokenId: "998", reason: "Closed." }, { conditionId: "0xold", tokenId: "999", reason: "Closed." }] })));
    const { markets } = managedMarketsForCycle(doc, FACTS, ["999"]);
    assert.deepEqual(markets.map((m) => [m.conditionId, m.side]), [["0xold", 1]]);
    const decision = reconcileTheme({ ...wallet({ holdings: [{ tokenId: "999", conditionId: "0xold", size: 100, redeemable: true, avgPrice: 0.8, valueUsd: 100 }] }), targets: { ok: true, doc }, markets });
    assert.deepEqual(decision.actions.map((a) => a.kind), ["redeem"]);
  });

  it("theme source: a managed config trades the confirmed markets, a legacy config its own list and nothing else", () => {
    const doc = value(parseThemeTargets(docOf("theme")));
    const managed = value(parseThemeConfig(theme({ thesis: "AI capex keeps growing", universe: "managed" })));
    const confirmed = managedMarketsForCycle(doc, FACTS).markets;
    assert.deepEqual(THEME_SOURCE.marketsFor(managed, doc, confirmed).markets, confirmed);
    const legacy = value(parseThemeConfig(theme({ thesis: "AI capex keeps growing", markets: [{ ...marketDoc, conditionId: "0xmine" }] })));
    assert.deepEqual(THEME_SOURCE.marketsFor(legacy, doc, confirmed).markets.map((m) => m.conditionId), ["0xmine"]);
  });
});

describe("a managed single-asset key", () => {
  const strategy = { assetKey: "NVDA", direction: "both" as const, universe: "managed" as const };
  const asset = (over: Record<string, unknown> = {}): AssetMarketsTargetsDoc => value(parseAssetMarketsTargets(docOf("stock-ls", over)));

  it("accepts any confirmed market, and keeps the rule: Q present, the limit from 0.70 to 0.97, and 5 points under Q", () => {
    const confirmed = managedMarketsForCycle(asset(), FACTS).markets;
    assert.equal(assetMarketsForCycle(asset(), strategy, [], confirmed).doc.targets.length, 1);
    for (const [over, expected] of [
      [{ maxPrice: 0.65 }, /below 0\.7/], [{ maxPrice: 0.98, q: 1 }, /above 0\.97/], [{ q: 0.78 }, /not 5 points above/], [{ rule: "market", q: null }, /has not forecast/],
    ] as const) {
      const doc = asset({ targets: [target(over)] });
      const checked = assetMarketsForCycle(doc, strategy, [], managedMarketsForCycle(doc, FACTS).markets);
      assert.equal(checked.doc.targets.length, 0);
      assert.match(checked.refused[0]!, expected);
    }
  });

  it("refuses a target whose market was not confirmed", () => {
    const checked = assetMarketsForCycle(asset(), strategy, [], []);
    assert.equal(checked.doc.targets.length, 0);
    assert.match(checked.refused[0]!, /not confirmed on Polymarket/);
  });

  it("a legacy key still refuses a market the creator did not choose, and still holds the direction", () => {
    const legacy = { assetKey: "NVDA", direction: "short" as const, markets: [marketDoc as ThemeMarket] };
    assert.match(assetMarketsForCycle(asset(), legacy).refused[0]!, /short-only key does not take/);
    assert.match(assetMarketsForCycle(asset({ targets: [target({ id: "0xzzz:0", conditionId: "0xzzz" })] }), legacy).refused[0]!, /not one of the configured markets/);
  });

  it("one cycle, read through the venue: targets are confirmed, then anything held that the list no longer names", async () => {
    const asked: string[][] = [];
    const snapshots: string[][] = [];
    const holding = { tokenId: "999", conditionId: "0xold", size: 10, redeemable: false, avgPrice: 0.8, valueUsd: 8 };
    const venue = {
      marketFacts: async (tokenIds: readonly string[]) => { asked.push([...tokenIds]); return new Map([...FACTS].filter(([id]) => tokenIds.includes(id))); },
      snapshot: async (markets: ThemeMarket[]) => { snapshots.push(markets.map((m) => m.conditionId)); return { holdings: [holding], quotes: {}, books: {}, collateralUsd: 0, exposureUsd: 8, equityUsd: 8, pendingTokenIds: [], orders: [] } as unknown as PolymarketSnapshot; },
    };
    const config = value(parseConfig(stock(strategy))) as ConfigDoc;
    const read = await readCycle(ASSET_SOURCE as PolymarketSource, config, asset(), venue);
    assert.deepEqual(asked, [["111"], ["999"]]);
    assert.deepEqual(snapshots, [["0xabc"], ["0xabc", "0xold"]]);
    assert.deepEqual(read.allowed.markets.map((m) => m.conditionId), ["0xabc", "0xold"]);
    // A legacy key asks Polymarket nothing.
    asked.length = 0;
    await readCycle(ASSET_SOURCE as PolymarketSource, value(parseConfig(stock({ assetKey: "NVDA", markets: [marketDoc] }))), asset(), venue);
    assert.deepEqual(asked, []);
  });
});

describe("money review 0.5.1: the 70-cent floor and the 5 points, at the moment of the order", () => {
  const doc: ThemeTargetsDoc = { ...value(parseAssetMarketsTargets(docOf("stock-ls"))), strategyId: "theme" };
  const markets = [marketDoc as ThemeMarket];
  const entryRule = { minBuyPrice: ASSET_MARKET_MIN_PRICE, minEdge: ASSET_MARKET_MIN_EDGE };

  it("does not buy an outcome whose ask fell under the floor after the targets were computed (ask 0.40, limit 0.75)", () => {
    const collapsed = { "111": { bid: 0.38, ask: 0.4 } };
    // Before the fix: a full-size buy at 0.40.
    assert.equal(reconcileTheme({ ...wallet({ quotes: collapsed }), targets: { ok: true, doc }, markets }).actions[0]?.kind, "buy");
    const decision = reconcileTheme({ ...wallet({ quotes: collapsed }), targets: { ok: true, doc }, markets, entryRule });
    assert.deepEqual(decision.actions, []);
    assert.ok(decision.notes.some((note) => /the ask 0\.4 is under the 0\.7 floor/.test(note)));
  });

  it("still buys at a live price that keeps the rule, and the single-asset source is the only one that carries it", () => {
    assert.equal(reconcileTheme({ ...wallet(), targets: { ok: true, doc }, markets, entryRule }).actions[0]?.kind, "buy");
    assert.deepEqual(ASSET_SOURCE.entryRule, entryRule);
    assert.equal(THEME_SOURCE.entryRule, undefined);
  });
});

describe("money review 0.5.1: strats fund while a buyback is part-way", () => {
  const ports = (over: Partial<FundGuardPorts> = {}, calls: string[] = []): FundGuardPorts => ({
    localJournal: () => { calls.push("local"); return null; },
    pause: () => { calls.push("pause"); return { ok: true }; },
    pull: () => { calls.push("pull"); return { ok: true, added: 0, journal: "none" }; },
    release: () => { calls.push("release"); return { ok: true }; },
    ...over,
  });
  const auto = { deployment: { dropletId: 1, host: "203.0.113.5", region: "blr1", size: "s-1vcpu-1gb", version: "0.5.1", deployedAt: "2026-09-19T00:00:00.000Z", autoBuyback: true } };

  it("refuses for a journal on this machine at any stage, and for one that cannot be read", () => {
    for (const localJournal of [() => ({ stage: "arrived" }), () => ({ stage: "confirmed" }), () => { throw new Error("unreadable"); }]) {
      const guard = guardPartWayBuyback({}, ports({ localJournal }));
      assert.equal(guard.ok, false);
      assert.match((guard as { message: string }).message, /A buyback is part-way.*Finish it first: strats buyback --execute/);
    }
    assert.deepEqual(guardPartWayBuyback({}, ports()), { ok: true, held: false });
  });

  it("a droplet that buys back is paused first, then asked; a part-way buyback there refuses and lifts the pause", () => {
    const calls: string[] = [];
    const guard = guardPartWayBuyback(auto, ports({ pull: () => { calls.push("pull"); return { ok: true, added: 0, journal: "left", stage: "arrived" }; } }, calls));
    assert.deepEqual(calls, ["local", "pause", "pull", "release"]);
    assert.equal(guard.ok, false);
    assert.match((guard as { message: string }).message, /part-way through a buyback \(arrived\)/);
  });

  it("refuses when the droplet cannot be paused or asked, and goes on, holding the pause, when it has nothing part-way", () => {
    assert.equal(guardPartWayBuyback(auto, ports({ pause: () => ({ ok: false, message: "ssh failed" }) })).ok, false);
    assert.equal(guardPartWayBuyback(auto, ports({ pull: () => ({ ok: false, message: "ssh failed" }) })).ok, false);
    assert.deepEqual(guardPartWayBuyback(auto, ports()), { ok: true, held: true });
  });
});

describe("money review 0.5.1: auto-buyback is offered only where profit is read from the venue's own history", () => {
  it("a single-asset bot, never a theme or team bot", () => {
    assert.equal(autoBuybackAvailable({ strategyId: "stock-ls" }), true);
    assert.equal(autoBuybackAvailable({ strategyId: "theme" }), false);
    assert.equal(autoBuybackAvailable({ strategyId: "team" }), false);
  });
});
