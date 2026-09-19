import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TargetDoc } from "../src/protocol/index.js";
import { describeDecision, floorToDecimals, reconcile, venuePrice, type Decision, type OrderView, type ReconcileInput } from "../src/reconcile.js";

const NOW = Date.parse("2026-09-18T12:00:00.000Z");
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

function doc(overrides: Partial<TargetDoc["target"]> = {}, top: Partial<Omit<TargetDoc, "target">> = {}): TargetDoc {
  return {
    v: 1, strategyId: "stock-ls", asOf: iso(-10_000), validUntil: iso(290_000), mode: "open",
    target: {
      assetKey: "crypto:btc", coin: "BTC", dex: "", side: "long", flatReason: null,
      entryLimit: 101_000, targetPx: 102_000, stopPx: 98_500, expiresAt: iso(3_600_000),
      signalId: "sig-1", revision: 1, reason: "Q is long BTC.",
      ...overrides,
    },
    ...top,
  };
}

const flat = (flatReason: "neutral" | "expired" | "unavailable"): TargetDoc =>
  doc({ side: "flat", flatReason, entryLimit: null, targetPx: null, stopPx: null, expiresAt: null, signalId: null, revision: null, reason: "No signal." });

const short = (): TargetDoc => doc({ side: "short", entryLimit: 99_000, targetPx: 98_000, stopPx: 101_500 });

function input(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    target: { ok: true, doc: doc() }, now: NOW, position: null, openOrders: [],
    mid: 100_000, bid: 99_995, ask: 100_005, equityUsd: 10_000, positionPct: 10, ceilingPct: 10,
    instrument: { szDecimals: 5, minNotional: 10 }, dryRun: false,
    ...overrides,
  };
}

const longPosition = { side: "long" as const, size: 0.01, entryPx: 100_000 };
const stopOrder = (triggerPx: number, extra: Partial<OrderView> = {}): OrderView =>
  ({ id: "stop-1", side: "sell", remainingSize: 0.01, price: triggerPx * 0.98, reduceOnly: true, isTrigger: true, triggerPx, triggerKind: "sl", ...extra });
const targetOrder = (price: number, extra: Partial<OrderView> = {}): OrderView =>
  ({ id: "target-1", side: "sell", remainingSize: 0.01, price, reduceOnly: true, isTrigger: false, ...extra });

function expectKind<K extends Decision["kind"]>(decision: Decision, kind: K): Extract<Decision, { kind: K }> {
  assert.equal(decision.kind, kind, `expected ${kind}, got ${JSON.stringify(decision)}`);
  return decision as Extract<Decision, { kind: K }>;
}

describe("hold: a fault never opens and never closes", () => {
  it("holds on a fetch failure", () => {
    const d = expectKind(reconcile(input({ target: { ok: false, reason: "Could not reach the gateway (network error)." } })), "hold");
    assert.match(d.reason, /gateway/);
  });

  it("holds on a fetch failure even with an open position", () => {
    expectKind(reconcile(input({ target: { ok: false, reason: "The gateway answered 503 (target_unavailable)." }, position: longPosition })), "hold");
  });

  it("holds when now is past validUntil", () => {
    const d = expectKind(reconcile(input({ target: { ok: true, doc: doc({}, { validUntil: iso(-1) }) }, position: longPosition })), "hold");
    assert.match(d.reason, /expired/);
  });

  it("does not hold at exactly validUntil", () => {
    assert.notEqual(reconcile(input({ target: { ok: true, doc: doc({}, { validUntil: iso(0) }) } })).kind, "hold");
  });

  it("holds on flat+unavailable even with an open position", () => {
    expectKind(reconcile(input({ target: { ok: true, doc: flat("unavailable") }, position: longPosition, openOrders: [stopOrder(98_500)] })), "hold");
  });

  it("holds on a stale neutral target rather than closing", () => {
    const stale = { ...flat("neutral"), validUntil: iso(-60_000) };
    expectKind(reconcile(input({ target: { ok: true, doc: stale }, position: longPosition })), "hold");
  });
});

describe("flat targets", () => {
  it("closes on flat+neutral", () => {
    expectKind(reconcile(input({ target: { ok: true, doc: flat("neutral") }, position: longPosition })), "close");
  });

  it("closes on flat+expired", () => {
    const d = expectKind(reconcile(input({ target: { ok: true, doc: flat("expired") }, position: longPosition })), "close");
    assert.match(d.reason, /expired/);
  });

  it("does nothing when flat with no position", () => {
    expectKind(reconcile(input({ target: { ok: true, doc: flat("neutral") } })), "none");
  });

  it("removes exits left behind once the position is gone", () => {
    const d = expectKind(reconcile(input({ target: { ok: true, doc: flat("neutral") }, openOrders: [stopOrder(98_500), targetOrder(102_000)] })), "repair");
    assert.deepEqual(d.cancelOrderIds.sort(), ["stop-1", "target-1"]);
    assert.equal(d.placeStop, undefined);
    assert.equal(d.placeTarget, undefined);
  });

  it("closes on neutral even in reduce-only mode", () => {
    expectKind(reconcile(input({ target: { ok: true, doc: { ...flat("neutral"), mode: "reduce-only" } }, position: longPosition })), "close");
  });
});

describe("entries", () => {
  it("opens a long inside the entry limit", () => {
    const d = expectKind(reconcile(input()), "open");
    assert.equal(d.side, "long");
    assert.equal(d.stopPx, 98_500);
    assert.equal(d.targetPx, 102_000);
    assert.ok(d.limitPx <= 101_000 && d.limitPx >= 100_005);
    assert.ok(d.notionalUsd <= 1_000 && d.notionalUsd > 990);
  });

  it("opens a short inside the entry limit", () => {
    const d = expectKind(reconcile(input({ target: { ok: true, doc: short() } })), "open");
    assert.equal(d.side, "short");
    assert.ok(d.limitPx >= 99_000 && d.limitPx <= 99_995);
  });

  it("never opens a long above entryLimit", () => {
    const d = expectKind(reconcile(input({ mid: 101_200, bid: 101_195, ask: 101_205 })), "none");
    assert.match(d.reason, /above the entry limit/);
  });

  it("never opens a short below entryLimit", () => {
    const d = expectKind(reconcile(input({ target: { ok: true, doc: short() }, mid: 98_800, bid: 98_795, ask: 98_805 })), "none");
    assert.match(d.reason, /below the entry limit/);
  });

  it("caps the long limit price at entryLimit", () => {
    const d = expectKind(reconcile(input({ mid: 100_990, bid: 100_985, ask: 100_995 })), "open");
    assert.ok(d.limitPx <= 101_000);
  });

  it("never opens at or after expiresAt", () => {
    expectKind(reconcile(input({ target: { ok: true, doc: doc({ expiresAt: iso(0) }) } })), "none");
    expectKind(reconcile(input({ target: { ok: true, doc: doc({ expiresAt: iso(-1) }) } })), "none");
  });

  it("closes an open position at or after expiresAt", () => {
    expectKind(reconcile(input({ target: { ok: true, doc: doc({ expiresAt: iso(0) }) }, position: longPosition })), "close");
  });

  it("treats a null expiresAt as no expiry", () => {
    expectKind(reconcile(input({ target: { ok: true, doc: doc({ expiresAt: null }) } })), "open");
  });

  it("does not open when the price has crossed the stop", () => {
    const d = expectKind(reconcile(input({ mid: 98_400, bid: 98_395, ask: 98_405 })), "none");
    assert.match(d.reason, /stop/);
  });

  it("does not open when the price has reached the target", () => {
    const d = expectKind(reconcile(input({ target: { ok: true, doc: doc({ entryLimit: 103_000 }) }, mid: 102_100, bid: 102_095, ask: 102_105 })), "none");
    assert.match(d.reason, /target/);
  });

  it("reduce-only mode blocks opens", () => {
    const d = expectKind(reconcile(input({ target: { ok: true, doc: doc({}, { mode: "reduce-only" }) } })), "none");
    assert.match(d.reason, /reduce-only/);
  });

  it("reduce-only mode still manages and closes", () => {
    const reduceOnly = doc({}, { mode: "reduce-only" });
    expectKind(reconcile(input({ target: { ok: true, doc: reduceOnly }, position: longPosition })), "repair");
    expectKind(reconcile(input({ target: { ok: true, doc: doc({ side: "short", entryLimit: 99_000, targetPx: 98_000, stopPx: 101_500 }, { mode: "reduce-only" }) }, position: longPosition })), "close");
  });

  it("an open-blocked reason stops the open but not the close", () => {
    const blocked = "The account is not in Standard mode.";
    assert.equal(expectKind(reconcile(input({ openBlockedReason: blocked })), "none").reason, blocked);
    expectKind(reconcile(input({ openBlockedReason: blocked, target: { ok: true, doc: flat("neutral") }, position: longPosition })), "close");
  });
});

describe("opposite side", () => {
  it("closes a long when the target is short, and does not open in the same cycle", () => {
    const d = expectKind(reconcile(input({ target: { ok: true, doc: short() }, position: longPosition })), "close");
    assert.match(d.reason, /long.*short/);
  });

  it("closes a short when the target is long", () => {
    expectKind(reconcile(input({ position: { side: "short", size: 0.01, entryPx: 100_000 } })), "close");
  });
});

describe("sizing", () => {
  it("the local ceiling clamps the configured percentage", () => {
    const d = expectKind(reconcile(input({ positionPct: 20, ceilingPct: 5 })), "open");
    assert.ok(d.notionalUsd <= 500 && d.notionalUsd > 495, String(d.notionalUsd));
  });

  it("the configured percentage applies when it is below the ceiling", () => {
    const d = expectKind(reconcile(input({ positionPct: 3, ceilingPct: 25 })), "open");
    assert.ok(d.notionalUsd <= 300 && d.notionalUsd > 295, String(d.notionalUsd));
  });

  it("hard cap: never more than 50% whatever the config and ceiling say", () => {
    const d = expectKind(reconcile(input({ positionPct: 90, ceilingPct: 80 })), "open");
    assert.ok(d.notionalUsd <= 5_000 && d.notionalUsd > 4_990, String(d.notionalUsd));
  });

  it("floors size to szDecimals", () => {
    const d = expectKind(reconcile(input({ equityUsd: 12_345.67, instrument: { szDecimals: 3, minNotional: 10 } })), "open");
    assert.equal(d.sizeBase, Number(d.sizeBase.toFixed(3)));
    assert.ok(d.sizeBase * d.limitPx <= 1_234.567);
    assert.ok((d.sizeBase + 0.001) * d.limitPx > 1_234.567, "one more step would exceed the budget");
    assert.equal(d.sizeBase, 0.012);
  });

  it("floors whole-unit instruments", () => {
    const stock = doc({ coin: "xyz:NVDA", dex: "xyz", assetKey: "stock:nvda", entryLimit: 181, targetPx: 184, stopPx: 176 });
    const d = expectKind(reconcile(input({ target: { ok: true, doc: stock }, mid: 180, bid: 179.95, ask: 180.05, equityUsd: 5_000, instrument: { szDecimals: 0, minNotional: 10 } })), "open");
    assert.equal(d.sizeBase, 2);
  });

  it("floorToDecimals does not undershoot representable values", () => {
    assert.equal(floorToDecimals(0.29, 2), 0.29);
    assert.equal(floorToDecimals(1.005, 3), 1.005);
    assert.equal(floorToDecimals(0.123456789, 5), 0.12345);
    assert.equal(floorToDecimals(7.9, 0), 7);
  });

  it("refuses below the minimum notional and names the deposit", () => {
    const d = expectKind(reconcile(input({ equityUsd: 0 })), "none");
    assert.match(d.reason, /Deposit at least \$\d+ more/);
    assert.match(d.reason, /\$10\.00 minimum/);
    const needed = Number(/Deposit at least \$(\d+) more/.exec(d.reason)![1]);
    // With that deposit in the wallet the same input opens.
    expectKind(reconcile(input({ equityUsd: needed })), "open");
  });

  it("names only the shortfall when the wallet already holds something", () => {
    const d = expectKind(reconcile(input({ equityUsd: 60 })), "none");
    const needed = Number(/Deposit at least \$(\d+) more/.exec(d.reason)![1]);
    assert.ok(needed > 0 && needed < 60, String(needed));
    expectKind(reconcile(input({ equityUsd: 60 + needed })), "open");
  });

  it("honors an instrument minimum above the venue minimum", () => {
    expectKind(reconcile(input({ equityUsd: 300, instrument: { szDecimals: 5, minNotional: 50 } })), "none");
  });
});

describe("repair", () => {
  it("places both exits when a position has none", () => {
    const d = expectKind(reconcile(input({ position: longPosition })), "repair");
    assert.equal(d.placeStop, 98_500);
    assert.equal(d.placeTarget, 102_000);
    assert.deepEqual(d.cancelOrderIds, []);
  });

  it("places only the stop when the target is already there", () => {
    const d = expectKind(reconcile(input({ position: longPosition, openOrders: [targetOrder(102_000)] })), "repair");
    assert.equal(d.placeStop, 98_500);
    assert.equal(d.placeTarget, undefined);
  });

  it("does nothing when both exits are correct", () => {
    const d = expectKind(reconcile(input({ position: longPosition, openOrders: [stopOrder(98_500), targetOrder(102_000)] })), "none");
    assert.match(d.reason, /Holding long/);
  });

  it("replaces both exits when a new revision moves the prices", () => {
    const revised = doc({ stopPx: 99_000, targetPx: 103_000, revision: 2 });
    const d = expectKind(reconcile(input({ target: { ok: true, doc: revised }, position: longPosition, openOrders: [stopOrder(98_500), targetOrder(102_000)] })), "repair");
    assert.equal(d.placeStop, 99_000);
    assert.equal(d.placeTarget, 103_000);
    assert.deepEqual(d.cancelOrderIds.sort(), ["stop-1", "target-1"]);
  });

  it("compares against the price the venue actually carries", () => {
    // 98,500.4 rounds up to 98,501 for a sell stop at 5 significant figures.
    const precise = doc({ stopPx: 98_500.4, targetPx: 102_000.2 });
    assert.equal(venuePrice(98_500.4, 5, "sell"), 98_501);
    expectKind(reconcile(input({ target: { ok: true, doc: precise }, position: longPosition, openOrders: [stopOrder(98_501), targetOrder(102_001)] })), "none");
  });

  it("replaces a stop that no longer covers the position", () => {
    const d = expectKind(reconcile(input({ position: longPosition, openOrders: [stopOrder(98_500, { remainingSize: 0.004 }), targetOrder(102_000)] })), "repair");
    assert.equal(d.placeStop, 98_500);
    assert.deepEqual(d.cancelOrderIds, ["stop-1"]);
  });

  it("cancels a duplicate stop and keeps one", () => {
    const d = expectKind(reconcile(input({ position: longPosition, openOrders: [stopOrder(98_500), stopOrder(98_500, { id: "stop-2" }), targetOrder(102_000)] })), "repair");
    assert.equal(d.placeStop, undefined);
    assert.deepEqual(d.cancelOrderIds, ["stop-2"]);
  });

  it("ignores orders that are not ours", () => {
    const foreign: OrderView[] = [
      { id: "resting-buy", side: "buy", remainingSize: 1, price: 90_000, reduceOnly: false, isTrigger: false },
      { id: "manual-tp", side: "sell", remainingSize: 0.01, price: 105_000, reduceOnly: true, isTrigger: true, triggerPx: 105_000, triggerKind: "tp" },
    ];
    const d = expectKind(reconcile(input({ position: longPosition, openOrders: [...foreign, stopOrder(98_500), targetOrder(102_000)] })), "none");
    assert.match(d.reason, /in place/);
  });

  it("closes when the price is through the stop and no stop is resting", () => {
    const d = expectKind(reconcile(input({ position: longPosition, mid: 98_400, bid: 98_395, ask: 98_405 })), "close");
    assert.match(d.reason, /through the stop/);
  });

  it("leaves a resting stop to do its work when the price is through it", () => {
    expectKind(reconcile(input({ position: longPosition, mid: 98_400, bid: 98_395, ask: 98_405, openOrders: [stopOrder(98_500), targetOrder(102_000)] })), "none");
  });

  it("repairs a short with buy-side exits", () => {
    const d = expectKind(reconcile(input({ target: { ok: true, doc: short() }, position: { side: "short", size: 0.01, entryPx: 99_500 }, openOrders: [stopOrder(101_500, { side: "buy" })] })), "repair");
    assert.equal(d.placeStop, undefined);
    assert.equal(d.placeTarget, 98_000);
  });
});

describe("purity and wording", () => {
  it("dryRun never changes the decision", () => {
    for (const overrides of [{}, { position: longPosition }, { equityUsd: 0 }, { target: { ok: true as const, doc: flat("neutral") }, position: longPosition }]) {
      assert.deepEqual(reconcile(input({ ...overrides, dryRun: true })), reconcile(input({ ...overrides, dryRun: false })));
    }
  });

  it("does not mutate its input", () => {
    const frozen = input({ position: longPosition, openOrders: [stopOrder(98_000)] });
    const before = JSON.stringify(frozen);
    reconcile(frozen);
    assert.equal(JSON.stringify(frozen), before);
  });

  it("describes a dry run as what it would do, in one line", () => {
    const line = describeDecision(reconcile(input()), "BTC", true);
    assert.match(line, /^Would open long [\d.]+ BTC at up to \$/);
    assert.ok(!line.includes("\n"));
    assert.ok(!line.includes("!"));
  });
});
