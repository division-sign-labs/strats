import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ThemeMarket, ThemeTargetsDoc } from "../src/protocol/index.js";
import { THEME_MAX_BUYS_PER_CYCLE, describeThemeDecision, floorShares, reconcileTheme, type ThemeReconcileInput } from "../src/reconcile-theme.js";

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const market = (n: number, side: 0 | 1 = 0): ThemeMarket => ({ conditionId: `0xcond${n}`, tokenIds: [`yes${n}`, `no${n}`], outcomes: ["Yes", "No"], side, question: `Question ${n}?`, marketKey: null });
const target = (n: number, over: Partial<ThemeTargetsDoc["targets"][number]> = {}): ThemeTargetsDoc["targets"][number] => ({
  id: `0xcond${n}:0`, venue: "polymarket", conditionId: `0xcond${n}`, tokenId: `yes${n}`, outcome: "Yes", question: `Question ${n}?`,
  maxPrice: 0.6, takeProfitPrice: 0.9, expiresAt: null, rule: "q", q: 0.7, reason: "Q is above the market.", ...over,
});
const doc = (over: Partial<ThemeTargetsDoc> = {}): ThemeTargetsDoc => ({
  v: 1, strategyId: "theme", asOf: new Date(NOW - 60_000).toISOString(), validUntil: new Date(NOW + 240_000).toISOString(), mode: "open", targets: [target(1)], closed: [], ...over,
});
const input = (over: Partial<ThemeReconcileInput> = {}): ThemeReconcileInput => ({
  targets: { ok: true, doc: doc() }, now: NOW, markets: [market(1), market(2), market(3), market(4), market(5)],
  holdings: [], quotes: { yes1: { bid: 0.48, ask: 0.5 } }, collateralUsd: 1000, equityUsd: 1000, exposureUsd: 0,
  positionPct: 10, ceilingPct: 10, blockedTargetIds: [], redeemedConditionIds: [], pendingTokenIds: [], ...over,
});

describe("reconcileTheme: hold", () => {
  it("holds on a fetch failure and does nothing, even with a position that would otherwise be sold", () => {
    const d = reconcileTheme(input({ targets: { ok: false, reason: "Could not reach the gateway." }, holdings: [{ tokenId: "yes1", conditionId: "0xcond1", size: 100, redeemable: false }], quotes: { yes1: { bid: 0.95, ask: 0.96 } } }));
    assert.equal(d.hold, "Could not reach the gateway.");
    assert.deepEqual(d.actions, []);
  });

  it("holds when the targets are past validUntil", () => {
    const stale = doc({ validUntil: new Date(NOW - 1).toISOString(), closed: [{ conditionId: "0xcond1", tokenId: "yes1", reason: "resolved" }], targets: [] });
    const d = reconcileTheme(input({ targets: { ok: true, doc: stale }, holdings: [{ tokenId: "yes1", conditionId: "0xcond1", size: 100, redeemable: true }] }));
    assert.match(d.hold ?? "", /expired/);
    assert.deepEqual(d.actions, []);
  });

  it("holds when validUntil cannot be read as a time", () => {
    const d = reconcileTheme(input({ targets: { ok: true, doc: doc({ validUntil: "not a time" }) } }));
    assert.notEqual(d.hold, null);
    assert.deepEqual(d.actions, []);
  });

  it("acts at exactly validUntil", () => {
    assert.equal(reconcileTheme(input({ now: Date.parse(doc().validUntil) })).hold, null);
  });
});

describe("reconcileTheme: entries", () => {
  it("buys an unheld target at the ask, sized to the position percent", () => {
    const d = reconcileTheme(input());
    assert.equal(d.actions.length, 1);
    const a = d.actions[0]!;
    assert.equal(a.kind, "buy");
    if (a.kind !== "buy") return;
    assert.equal(a.limitPx, 0.5);
    assert.equal(a.budgetUsd, 100);
    assert.equal(a.shares, 200);
    assert.equal(a.targetId, "0xcond1:0");
  });

  it("uses the smallest of server percent, local ceiling and the 50 hard cap", () => {
    const buy = (positionPct: number, ceilingPct: number) => {
      const a = reconcileTheme(input({ positionPct, ceilingPct })).actions[0]!;
      return a.kind === "buy" ? a.budgetUsd : -1;
    };
    assert.equal(buy(50, 5), 50);
    assert.equal(buy(5, 50), 50);
    assert.equal(buy(90, 90), 500);
  });

  it("never pays above maxPrice", () => {
    const d = reconcileTheme(input({ quotes: { yes1: { bid: 0.6, ask: 0.61 } } }));
    assert.deepEqual(d.actions, []);
    assert.match(d.notes.join(" "), /above the limit/);
  });

  it("never opens a market that is already held, on either token", () => {
    assert.deepEqual(reconcileTheme(input({ holdings: [{ tokenId: "yes1", conditionId: "0xcond1", size: 10, redeemable: false }] })).actions, []);
    assert.deepEqual(reconcileTheme(input({ holdings: [{ tokenId: "no1", conditionId: "", size: 10, redeemable: false }] })).actions, []);
  });

  it("enters a target id once", () => {
    assert.deepEqual(reconcileTheme(input({ blockedTargetIds: ["0xcond1:0"] })).actions, []);
  });

  it("waits while one of our orders is resting on the token", () => {
    assert.deepEqual(reconcileTheme(input({ pendingTokenIds: ["yes1"] })).actions, []);
  });

  it("refuses a market the creator did not configure", () => {
    const d = reconcileTheme(input({ markets: [market(2)] }));
    assert.deepEqual(d.actions, []);
    assert.match(d.notes.join(" "), /not one of the configured markets/);
  });

  it("refuses a target that names the other outcome of a configured market", () => {
    const d = reconcileTheme(input({ targets: { ok: true, doc: doc({ targets: [target(1, { tokenId: "no1" })] }) }, quotes: { no1: { bid: 0.4, ask: 0.5 } } }));
    assert.deepEqual(d.actions, []);
    assert.match(d.notes.join(" "), /different outcome/);
  });

  it("opens nothing in reduce-only mode but still sells", () => {
    const d = reconcileTheme(input({
      targets: { ok: true, doc: doc({ mode: "reduce-only", targets: [target(1), target(2)] }) },
      holdings: [{ tokenId: "yes2", conditionId: "0xcond2", size: 50, redeemable: false }],
      quotes: { yes1: { bid: 0.48, ask: 0.5 }, yes2: { bid: 0.93, ask: 0.95 } },
    }));
    assert.deepEqual(d.actions.map((a) => a.kind), ["sell"]);
  });

  it("opens nothing when the runner says opening is blocked", () => {
    const d = reconcileTheme(input({ openBlockedReason: "The settings could not be loaded. Not opening." }));
    assert.deepEqual(d.actions, []);
  });

  it("skips an expired target and one with no ask", () => {
    assert.deepEqual(reconcileTheme(input({ targets: { ok: true, doc: doc({ targets: [target(1, { expiresAt: new Date(NOW).toISOString() })] }) } })).actions, []);
    assert.deepEqual(reconcileTheme(input({ quotes: {} })).actions, []);
    assert.deepEqual(reconcileTheme(input({ quotes: { yes1: { bid: 0.4, ask: 0 } } })).actions, []);
  });

  it("keeps total exposure at or under 100 percent of equity", () => {
    const targets = [1, 2, 3].map((n) => target(n));
    const quotes = { yes1: { bid: 0.48, ask: 0.5 }, yes2: { bid: 0.48, ask: 0.5 }, yes3: { bid: 0.48, ask: 0.5 } };
    // 950 of 1000 is already in positions: only 50 of room is left, whatever the percent says.
    const d = reconcileTheme(input({ targets: { ok: true, doc: doc({ targets }) }, quotes, positionPct: 50, ceilingPct: 50, collateralUsd: 50, equityUsd: 1000, exposureUsd: 950 }));
    const spent = d.actions.reduce((sum, a) => sum + (a.kind === "buy" ? a.budgetUsd : 0), 0);
    assert.equal(spent, 50);
    assert.equal(d.actions.length, 1);
  });

  it("never spends more collateral than is free across several buys in one cycle", () => {
    const targets = [1, 2, 3].map((n) => target(n));
    const quotes = { yes1: { bid: 0.48, ask: 0.5 }, yes2: { bid: 0.48, ask: 0.5 }, yes3: { bid: 0.48, ask: 0.5 } };
    const d = reconcileTheme(input({ targets: { ok: true, doc: doc({ targets }) }, quotes, positionPct: 50, ceilingPct: 50, collateralUsd: 120, equityUsd: 120 }));
    const spent = d.actions.reduce((sum, a) => sum + (a.kind === "buy" ? a.budgetUsd : 0), 0);
    assert.ok(spent <= 120, `spent ${spent}`);
    assert.deepEqual(d.actions.map((a) => (a.kind === "buy" ? a.budgetUsd : 0)), [60, 60]);
  });

  it("caps the number of entries per cycle", () => {
    const targets = [1, 2, 3, 4, 5].map((n) => target(n));
    const quotes = Object.fromEntries(targets.map((t) => [t.tokenId, { bid: 0.48, ask: 0.5 }]));
    const d = reconcileTheme(input({ targets: { ok: true, doc: doc({ targets }) }, quotes, positionPct: 5, ceilingPct: 5 }));
    assert.equal(d.actions.length, THEME_MAX_BUYS_PER_CYCLE);
  });

  it("opens nothing when the budget is under the venue minimum", () => {
    const d = reconcileTheme(input({ collateralUsd: 2, equityUsd: 2 }));
    assert.deepEqual(d.actions, []);
    assert.match(d.notes.join(" "), /below the venue minimum/);
  });
});

describe("reconcileTheme: exits", () => {
  const held = [{ tokenId: "yes1", conditionId: "0xcond1", size: 123.456, redeemable: false }];

  it("keeps a held target below the take-profit price", () => {
    const d = reconcileTheme(input({ holdings: held, quotes: { yes1: { bid: 0.7, ask: 0.72 } } }));
    assert.deepEqual(d.actions, []);
    assert.equal(d.kept, 1);
  });

  it("sells a held target when the bid reaches the take-profit price, never more than is held", () => {
    const d = reconcileTheme(input({ holdings: held, quotes: { yes1: { bid: 0.9, ask: 0.92 } } }));
    assert.deepEqual(d.actions, [{ kind: "sell", conditionId: "0xcond1", tokenId: "yes1", shares: 123.45, minPrice: 0.9, why: "take-profit", reason: "The bid 0.9 reached the take-profit price 0.9." }]);
  });

  it("sells a held position whose market is closed, at the bid", () => {
    const d = reconcileTheme(input({ targets: { ok: true, doc: doc({ targets: [], closed: [{ conditionId: "0xcond1", tokenId: "yes1", reason: "The market closed." }] }) }, holdings: held, quotes: { yes1: { bid: 0.3, ask: 0.4 } } }));
    assert.equal(d.actions.length, 1);
    assert.equal(d.actions[0]!.kind, "sell");
  });

  it("redeems a resolved position once", () => {
    const closedDoc = doc({ targets: [], closed: [{ conditionId: "0xcond1", tokenId: "yes1", reason: "Resolved." }] });
    const holdings = [{ ...held[0]!, redeemable: true }];
    assert.deepEqual(reconcileTheme(input({ targets: { ok: true, doc: closedDoc }, holdings, quotes: {} })).actions.map((a) => a.kind), ["redeem"]);
    assert.deepEqual(reconcileTheme(input({ targets: { ok: true, doc: closedDoc }, holdings, quotes: {}, redeemedConditionIds: ["0xCOND1"] })).actions, []);
  });

  it("leaves alone a configured market that is in neither list, and a position the server never named", () => {
    const d = reconcileTheme(input({
      targets: { ok: true, doc: doc({ targets: [], closed: [] }) },
      holdings: [{ tokenId: "yes2", conditionId: "0xcond2", size: 40, redeemable: false }, { tokenId: "stranger", conditionId: "0xother", size: 99, redeemable: true }],
      quotes: { yes2: { bid: 0.99, ask: 1 }, stranger: { bid: 0.99, ask: 1 } },
    }));
    assert.deepEqual(d.actions, []);
  });

  it("never sells or redeems a position in a market the creator did not configure, even when the server names it", () => {
    const foreign = [{ tokenId: "yes9", conditionId: "0xcond9", size: 100, redeemable: false }, { tokenId: "yes8", conditionId: "0xcond8", size: 50, redeemable: true }];
    const named = doc({
      targets: [target(9, { id: "0xcond9:0" })],
      closed: [{ conditionId: "0xcond8", tokenId: "yes8", reason: "Resolved." }],
    });
    const d = reconcileTheme(input({ targets: { ok: true, doc: named }, holdings: foreign, quotes: { yes9: { bid: 0.97, ask: 0.98 }, yes8: { bid: 0.5, ask: 0.6 } } }));
    assert.equal(d.hold, null);
    assert.deepEqual(d.actions, []);
  });

  it("does not sell a closed position with no bid", () => {
    const d = reconcileTheme(input({ targets: { ok: true, doc: doc({ targets: [], closed: [{ conditionId: "0xcond1", tokenId: "yes1", reason: "Closed." }] }) }, holdings: held, quotes: { yes1: { bid: 0, ask: 0 } } }));
    assert.deepEqual(d.actions, []);
  });
});

describe("helpers", () => {
  it("floors shares to two decimals", () => {
    assert.equal(floorShares(1.159), 1.15);
    assert.equal(floorShares(1.15), 1.15);
    assert.equal(floorShares(-1), 0);
    assert.equal(floorShares(Number.NaN), 0);
  });

  it("describes a decision in one plain line", () => {
    assert.match(describeThemeDecision(reconcileTheme(input()), true), /^Would buy 200 "Yes"/);
    assert.match(describeThemeDecision(reconcileTheme(input({ targets: { ok: false, reason: "No answer." } })), false), /^Holding\. No answer\./);
  });
});
