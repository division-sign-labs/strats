// The venue wrapper against a scripted adapter: what is called, in what order, with what.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HyperliquidOrderNotSubmittedError, HyperliquidOrderRejectedError, type Order, type OrderIntent, type PerpMarketSnapshot, type Position } from "@quotient-forecasting/cassie-core";
import type { Decision } from "../src/reconcile.js";
import { Venue, type PerpAdapter, type VenueSnapshot } from "../src/venue.js";

type Call = { method: string; arg?: any };

const market: PerpMarketSnapshot = {
  instrument: { marketRef: "BTC", assetId: 0, dex: "", collateralToken: 0, szDecimals: 5, maxLeverage: 40, onlyIsolated: false, strictIsolated: false, minNotional: 10, maintenanceMarginRate: 0.0125, deployerFeeScale: 0, growthMode: false, active: true },
  quote: { marketRef: "BTC", bid: 99_995, ask: 100_005, mid: 100_000, volume24h: 2_000_000_000, spreadBps: 1, ts: Date.now() },
  book: { marketRef: "BTC", bids: [{ price: 99_995, size: 5 }], asks: [{ price: 100_005, size: 5 }], ts: Date.now() },
  markPrice: 100_000, oraclePrice: 100_000, fundingRateHourly: 0.0000125, makerFeeRate: 0.00015, takerFeeRate: 0.00045, ts: Date.now(),
};
const longPosition: Position = { marketRef: "BTC", side: "LONG", size: 0.0099, avgPrice: 100_004, currentPrice: 100_000, marginMode: "isolated", leverage: 1 };
const order = (id: string, extra: Partial<Order>): Order => ({ id, marketRef: "BTC", side: "SELL", size: 0.0099, filledSize: 0, price: 102_000, status: "open", reduceOnly: true, ...extra });
const stopOrder = order("11", { isTrigger: true, triggerKind: "sl", triggerPrice: 98_500, price: 96_530 });
const targetOrder = order("12", { isTrigger: false });

function snapshot(extra: Partial<VenueSnapshot> = {}): VenueSnapshot {
  return { coin: "BTC", accountMode: "disabled", standardMode: true, equityUsd: 10_000, availableUsd: 10_000, fundingBalanceUsd: 0, position: null, otherPositions: [], orders: [], market, ...extra };
}

interface Script {
  positions?: Position[][];
  openOrders?: Order[][];
  placeOrder?: (intent: OrderIntent) => unknown;
  placePerpStop?: () => unknown;
  lookup?: (clientId: string) => unknown;
}

function fake(script: Script = {}): { venue: Venue; calls: Call[] } {
  const calls: Call[] = [];
  const next = <T>(queue: T[][] | undefined, fallback: T[]): T[] => (queue && queue.length > 1 ? queue.shift()! : queue?.[0] ?? fallback);
  const adapter = {
    lookupPerpOrder: async (_a: unknown, clientId: string) => (calls.push({ method: "lookupPerpOrder", arg: clientId }), script.lookup?.(clientId) ?? { found: false, definitive: false }),
    disarmScheduledCancel: async () => void calls.push({ method: "disarmScheduledCancel" }),
    configurePerpLeverage: async (_a: unknown, arg: unknown) => void calls.push({ method: "configurePerpLeverage", arg }),
    placeOrder: async (_a: unknown, intent: OrderIntent) => {
      calls.push({ method: "placeOrder", arg: intent });
      const result = script.placeOrder?.(intent);
      if (result instanceof Error) throw result;
      return result ?? (intent.reduceOnly ? { orderId: "77", status: "open" } : { orderId: "55", status: "filled", filledSize: 0.0099, avgFillPrice: 100_004 });
    },
    placePerpStop: async (_a: unknown, arg: unknown) => {
      calls.push({ method: "placePerpStop", arg });
      const result = script.placePerpStop?.();
      if (result instanceof Error) throw result;
      return result ?? { orderId: "66", status: "open" };
    },
    positions: async () => (calls.push({ method: "positions" }), next(script.positions, [])),
    openOrders: async () => (calls.push({ method: "openOrders" }), next(script.openOrders, [])),
    cancelOrder: async (_a: unknown, id: string) => void calls.push({ method: "cancelOrder", arg: id }),
    cancelAll: async () => void calls.push({ method: "cancelAll" }),
    book: async () => market.book,
    quote: async () => market.quote,
  } as unknown as PerpAdapter;
  const venue = new Venue({ coin: "BTC", dex: "", masterAddress: "0x1234567890abcdef1234567890abcdef12345678", agentPk: "0xnot-used-by-the-fake" }, adapter);
  return { venue, calls };
}

const open: Extract<Decision, { kind: "open" }> = { kind: "open", side: "long", sizeBase: 0.00997, limitPx: 100_205, stopPx: 98_500, targetPx: 102_000, notionalUsd: 0.00997 * 100_205 };
const signal = { signalId: "sig-1", revision: 3 };
const names = (calls: Call[]): string[] => calls.map((c) => c.method);

describe("openPosition", () => {
  it("follows the reference sequence and sizes the exits to the actual position", async () => {
    const { venue, calls } = fake({ positions: [[longPosition]] });
    const result = await venue.openPosition(open, snapshot(), signal);
    assert.ok(result.ok, result.text);
    assert.deepEqual(names(calls), ["lookupPerpOrder", "disarmScheduledCancel", "configurePerpLeverage", "placeOrder", "positions", "placePerpStop", "placeOrder"]);

    assert.deepEqual(calls[2]!.arg, { marketRef: "BTC", leverage: 1, marginMode: "isolated" });
    const entry = calls[3]!.arg as OrderIntent;
    assert.equal(entry.tif, "IOC");
    assert.equal(entry.reduceOnly, false);
    assert.equal(entry.side, "BUY");
    assert.equal(entry.size, 0.00997);
    assert.equal(entry.limitPrice, 100_205);
    assert.equal(entry.clientId, "strats:BTC:sig-1:3:entry:0");
    assert.equal(entry.triggers, undefined, "exits are separate orders, never order-attached triggers");

    const stop = calls[5]!.arg;
    assert.equal(stop.size, 0.0099, "stop is sized to the position the venue shows, not the requested size");
    assert.equal(stop.positionSide, "LONG");
    assert.equal(stop.stopPx, 98_500);
    assert.ok(stop.slippagePct > 0 && stop.slippagePct < 100);

    const target = calls[6]!.arg as OrderIntent;
    assert.deepEqual([target.side, target.tif, target.reduceOnly, target.size, target.limitPrice], ["SELL", "GTC", true, 0.0099, 102_000]);
  });

  it("derives the same client id for the same signal revision, so a restart cannot double-enter", async () => {
    const a = fake({ positions: [[longPosition]] });
    const b = fake({ positions: [[longPosition]] });
    await a.venue.openPosition(open, snapshot(), signal);
    await b.venue.openPosition(open, snapshot(), signal);
    assert.equal(a.calls[3]!.arg.clientId, b.calls[3]!.arg.clientId);
  });

  it("does not enter a signal revision twice", async () => {
    const { venue, calls } = fake({ lookup: () => ({ found: true, order: {}, ack: { orderId: "5", status: "filled", filledSize: 0.0099 } }) });
    const result = await venue.openPosition(open, snapshot(), signal);
    assert.match(result.text, /already entered/);
    assert.ok(!names(calls).includes("placeOrder"));
  });

  it("uses the next attempt id after an unfilled entry, and stops after three", async () => {
    const unfilled = { found: true, order: {}, ack: { orderId: "5", status: "canceled", filledSize: 0 } };
    const second = fake({ positions: [[longPosition]], lookup: (id) => (id.endsWith(":0") ? unfilled : { found: false, definitive: false }) });
    await second.venue.openPosition(open, snapshot(), signal);
    assert.equal(second.calls.find((c) => c.method === "placeOrder")!.arg.clientId, "strats:BTC:sig-1:3:entry:1");
    const spent = fake({ lookup: () => unfilled });
    assert.match((await spent.venue.openPosition(open, snapshot(), signal)).text, /went unfilled/);
    assert.ok(!names(spent.calls).includes("placeOrder"));
  });

  it("sends nothing when leverage cannot be set", async () => {
    const { venue, calls } = fake();
    (venue as any).adapter.configurePerpLeverage = async () => {
      throw new Error("Hyperliquid perp strategy requires explicit Standard account mode; found default");
    };
    const result = await venue.openPosition(open, snapshot(), signal);
    assert.equal(result.ok, false);
    assert.match(result.text, /No order was sent/);
    assert.ok(!names(calls).includes("placeOrder"));
  });

  it("tells a rejection, a not-submitted order and an unknown outcome apart", async () => {
    const rejected = await fake({ placeOrder: () => new HyperliquidOrderRejectedError("Insufficient margin") }).venue.openPosition(open, snapshot(), signal);
    assert.match(rejected.text, /rejected the entry order: Insufficient margin\. Not retrying this cycle/);
    const notSubmitted = await fake({ placeOrder: () => new HyperliquidOrderNotSubmittedError("deferred") }).venue.openPosition(open, snapshot(), signal);
    assert.match(notSubmitted.text, /not submitted.*safe to retry/);
    const unknown = fake({ placeOrder: () => new Error("socket hang up") });
    const result = await unknown.venue.openPosition(open, snapshot(), signal);
    assert.match(result.text, /may or may not have reached Hyperliquid.*Not resending/);
    assert.equal(names(unknown.calls).filter((m) => m === "placeOrder").length, 1);
  });

  it("places no exits when the entry did not fill", async () => {
    const { venue, calls } = fake({ placeOrder: () => ({ orderId: "55", status: "open" }) });
    const result = await venue.openPosition(open, snapshot(), signal);
    assert.match(result.text, /did not fill/);
    assert.ok(!names(calls).includes("placePerpStop"));
  });

  it("still places the target and reports plainly when the stop fails", async () => {
    const { venue, calls } = fake({ positions: [[longPosition]], placePerpStop: () => new Error("Hyperliquid stop is already crossed; a reduce-only exit is required") });
    const result = await venue.openPosition(open, snapshot(), signal);
    assert.equal(result.ok, false);
    assert.match(result.text, /Opened long .* stop at \$98,500 could not be placed .*next cycle retries/);
    assert.equal(names(calls).at(-1), "placeOrder");
  });

  it("refuses a book too thin to fill the minimum", async () => {
    const thin = { ...market, book: { ...market.book, asks: [{ price: 100_005, size: 0.00001 }] } };
    const { venue, calls } = fake();
    const result = await venue.openPosition(open, snapshot({ market: thin }), signal);
    assert.match(result.text, /Not opening/);
    assert.ok(!names(calls).includes("placeOrder"));
  });
});

describe("closePosition", () => {
  it("cancels the target by id, closes reduce-only IOC, then cancels the stop once flat. Never cancelAll.", async () => {
    const { venue, calls } = fake({ openOrders: [[stopOrder]], positions: [[]] });
    const result = await venue.closePosition(snapshot({ position: longPosition, orders: [stopOrder, targetOrder] }));
    assert.ok(result.ok, result.text);
    assert.deepEqual(names(calls), ["cancelOrder", "openOrders", "placeOrder", "positions", "cancelOrder"]);
    assert.equal(calls[0]!.arg, "12");
    assert.equal(calls[4]!.arg, "11");
    const close = calls[2]!.arg as OrderIntent;
    assert.deepEqual([close.side, close.tif, close.reduceOnly, close.size], ["SELL", "IOC", true, 0.0099]);
    assert.ok(close.limitPrice < 99_995 && close.limitPrice > 99_000);
    assert.ok(!names(calls).includes("cancelAll"));
  });

  it("closes a position below the $10 entry minimum", async () => {
    const dust: Position = { ...longPosition, size: 0.00005 };
    const { venue, calls } = fake({ positions: [[]] });
    assert.ok((await venue.closePosition(snapshot({ position: dust }))).ok);
    assert.equal(calls.find((c) => c.method === "placeOrder")!.arg.size, 0.00005);
  });

  it("does not send the close while the target is still resting", async () => {
    const { venue, calls } = fake({ openOrders: [[stopOrder, targetOrder]] });
    const result = await venue.closePosition(snapshot({ position: longPosition, orders: [stopOrder, targetOrder] }));
    assert.equal(result.ok, false);
    assert.ok(!names(calls).includes("placeOrder"));
  });

  it("keeps the stop when the close only partly fills", async () => {
    const { venue, calls } = fake({ openOrders: [[stopOrder]], positions: [[{ ...longPosition, size: 0.004 }]] });
    const result = await venue.closePosition(snapshot({ position: longPosition, orders: [stopOrder, targetOrder] }));
    assert.equal(result.ok, false);
    assert.match(result.text, /0\.004 remains and the stop stays/);
    assert.deepEqual(calls.filter((c) => c.method === "cancelOrder").map((c) => c.arg), ["12"]);
  });

  it("leaves orders that are not ours alone", async () => {
    const foreign = order("90", { reduceOnly: false, side: "BUY", price: 90_000 });
    const { venue, calls } = fake({ positions: [[]] });
    await venue.closePosition(snapshot({ position: longPosition, orders: [foreign] }));
    assert.deepEqual(calls.filter((c) => c.method === "cancelOrder"), []);
  });
});

describe("repair", () => {
  const repair = (extra: Partial<Extract<Decision, { kind: "repair" }>>): Extract<Decision, { kind: "repair" }> => ({ kind: "repair", cancelOrderIds: [], ...extra });

  it("places the new stop before cancelling the old one, and cancels the old target before placing the new one", async () => {
    const { venue, calls } = fake();
    const result = await venue.repair(repair({ placeStop: 99_000, placeTarget: 103_000, cancelOrderIds: ["11", "12"] }), snapshot({ position: longPosition, orders: [stopOrder, targetOrder] }));
    assert.ok(result.ok, result.text);
    assert.deepEqual(calls.map((c) => `${c.method}:${c.arg?.stopPx ?? c.arg?.limitPrice ?? c.arg}`), ["placePerpStop:99000", "cancelOrder:11", "cancelOrder:12", "placeOrder:103000"]);
  });

  it("keeps the old stop when the new one cannot be placed", async () => {
    const { venue, calls } = fake({ placePerpStop: () => ({ orderId: "0", status: "rejected" }) });
    const result = await venue.repair(repair({ placeStop: 99_000, cancelOrderIds: ["11", "12"] }), snapshot({ position: longPosition, orders: [stopOrder, targetOrder] }));
    assert.equal(result.ok, false);
    assert.deepEqual(calls.filter((c) => c.method === "cancelOrder").map((c) => c.arg), ["12"]);
  });

  it("only cancels when the position is gone", async () => {
    const { venue, calls } = fake();
    await venue.repair(repair({ cancelOrderIds: ["11", "12"] }), snapshot({ orders: [stopOrder, targetOrder] }));
    assert.deepEqual(names(calls), ["cancelOrder", "cancelOrder"]);
  });
});
