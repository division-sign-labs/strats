import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OrderIntent } from "@quotient-forecasting/cassie-core";
import type { ThemeMarket } from "../src/protocol/index.js";
import { PolymarketVenue, orderIdentity, polymarketGeoblock, type PmAdapter, type PolymarketSnapshot } from "../src/venue-polymarket.js";

const market: ThemeMarket = { conditionId: "0xcond1", tokenIds: ["yes1", "no1"], outcomes: ["Yes", "No"], side: 0, question: "Will it happen?", marketKey: null };
const named: ThemeMarket = { conditionId: "0xcond2", tokenIds: ["a2", "b2"], outcomes: ["Sabalenka", "Rybakina"], side: 1, question: "Who wins?", marketKey: null };
const account = { signerAddress: "0x0000000000000000000000000000000000000001", funder: "0x0000000000000000000000000000000000000002", signatureType: 3 };
const creds = { venue: "polymarket" as const, signerPk: `0x${"11".repeat(32)}`, funder: account.funder, signatureType: 3, l2: { apiKey: "k", secret: "s", passphrase: "p" } };

interface Fake {
  orders: OrderIntent[];
  redeemed: string[];
  balance: number;
  place?: (intent: OrderIntent) => unknown;
}

function fakeAdapter(fake: Fake): PmAdapter {
  const book = (tokenId: string) => ({ marketRef: tokenId, bids: [{ price: 0.48, size: 1000 }], asks: [{ price: 0.5, size: 1000 }, { price: 0.7, size: 1000 }], ts: Date.now() });
  return {
    id: "polymarket", verifiedAgainst: "test",
    balances: async () => [{ asset: "pUSD", total: 500, available: 500 }],
    positions: async () => [{ marketRef: "yes1", tokenId: "yes1", conditionId: "0xcond1", outcome: "YES", side: "YES", size: 40, avgPrice: 0.4, currentPrice: 0.5 }],
    openOrders: async () => [],
    tokenBook: async (tokenId: string) => book(tokenId),
    tokenBalance: async () => fake.balance,
    fills: async () => [{ id: "f", marketRef: "yes1", side: "BUY", size: 10, price: 0.5, ts: 1 }],
    placeOrder: async (_acct: unknown, intent: OrderIntent) => {
      fake.orders.push(intent);
      return (fake.place?.(intent) ?? { orderId: "o1", status: "filled", filledSize: intent.size, avgFillPrice: intent.limitPrice }) as never;
    },
    redeem: async (_acct: unknown, position: { conditionId?: string }) => {
      fake.redeemed.push(position.conditionId ?? "");
      return { transactionHash: "0xhash" };
    },
    runFundingFlow: async () => { throw new Error("not used"); },
    cancelAll: async () => { throw new Error("cancelAll must never be called"); },
  } as unknown as PmAdapter;
}

const buyAction = { kind: "buy" as const, targetId: "0xcond1:0", conditionId: "0xcond1", tokenId: "yes1", outcome: "Yes", question: "Will it happen?", limitPx: 0.5, maxPrice: 0.505, shares: 100, budgetUsd: 50 };

describe("order identity", () => {
  it("addresses a Yes/No market by its Yes token and a named market by its first outcome", () => {
    assert.deepEqual(orderIdentity(market, "no1"), { marketRef: "yes1", outcome: "NO" });
    assert.deepEqual(orderIdentity(named, "b2"), { marketRef: "a2", outcome: "NO" });
    assert.deepEqual(orderIdentity(named, "a2"), { marketRef: "a2", outcome: "YES" });
    assert.throws(() => orderIdentity(market, "stranger"));
  });
});

describe("PolymarketVenue", () => {
  it("reads collateral, holdings and quotes, and finds a named-market holding with a direct balance read", async () => {
    const fake: Fake = { orders: [], redeemed: [], balance: 7 };
    const snap = await new PolymarketVenue(account, creds, {}, fakeAdapter(fake)).snapshot([market, named], ["yes1"]);
    assert.equal(snap.collateralUsd, 500);
    assert.deepEqual(snap.holdings.map((h) => [h.tokenId, h.size]), [["yes1", 40], ["a2", 7], ["b2", 7]]);
    assert.deepEqual(snap.quotes.yes1, { bid: 0.48, ask: 0.5 });
    assert.equal(snap.equityUsd, 500 + 40 * 0.5 + 2 * 7 * 0.48);
  });

  it("buys fill-and-kill, never above maxPrice, with a client id derived from the target", async () => {
    const fake: Fake = { orders: [], redeemed: [], balance: 0 };
    const venue = new PolymarketVenue(account, creds, {}, fakeAdapter(fake));
    const snap = await venue.snapshot([market], ["yes1"]);
    const result = await venue.buy(buyAction, market, snap);
    assert.equal(fake.orders.length, 1);
    const order = fake.orders[0]!;
    assert.equal(order.side, "BUY");
    assert.equal(order.tif, "FAK");
    assert.equal(order.clientId, "strats:theme:0xcond1:0");
    assert.equal(order.marketRef, "yes1");
    assert.equal(order.tokenId, "yes1");
    // The capacity check would allow 2% past the touch (0.51); the target's maxPrice is lower and wins.
    assert.equal(order.limitPrice, 0.505);
    assert.ok(order.size * order.limitPrice <= 50 + 1e-9);
    assert.ok(result.filledUsd > 0);
    assert.equal(result.trade?.action, "buy");
    assert.equal(result.trade?.sizeUsd, result.filledUsd);
  });

  it("does not buy when the wallet already holds the token, or when the holding cannot be confirmed", async () => {
    const held: Fake = { orders: [], redeemed: [], balance: 12 };
    const venue = new PolymarketVenue(account, creds, {}, fakeAdapter(held));
    const snap = await venue.snapshot([market], ["yes1"]);
    assert.match((await venue.buy(buyAction, market, snap)).text, /already holds 12 shares/);
    assert.equal(held.orders.length, 0);

    const broken = fakeAdapter({ orders: [], redeemed: [], balance: 0 });
    broken.tokenBalance = async () => { throw new Error("rate limited"); };
    const result = await new PolymarketVenue(account, creds, {}, broken).buy(buyAction, market, snap);
    assert.equal(result.ok, false);
    assert.match(result.text, /No order was sent/);
  });

  it("marks an order with an unknown result as uncertain, and a definite rejection as not", async () => {
    const fake: Fake = { orders: [], redeemed: [], balance: 0, place: () => { throw new Error("socket hang up"); } };
    const venue = new PolymarketVenue(account, creds, {}, fakeAdapter(fake));
    const snap = await venue.snapshot([market], ["yes1"]);
    const result = await venue.buy(buyAction, market, snap);
    assert.equal(result.uncertain, true);
    assert.match(result.text, /Not resending/);
    assert.equal(result.trade, undefined, "an order with an unknown result is not recorded as a trade");
  });

  it("sells no more than the wallet holds, at the bid or better", async () => {
    const fake: Fake = { orders: [], redeemed: [], balance: 25.129 };
    const venue = new PolymarketVenue(account, creds, {}, fakeAdapter(fake));
    await venue.sell({ kind: "sell", conditionId: "0xcond1", tokenId: "yes1", shares: 40, minPrice: 0.9, why: "take-profit", reason: "r" }, market);
    assert.equal(fake.orders[0]!.side, "SELL");
    assert.equal(fake.orders[0]!.size, 25.12);
    assert.equal(fake.orders[0]!.limitPrice, 0.9);
    assert.equal(fake.orders[0]!.tif, "FAK");
  });

  it("sends nothing when read-only", async () => {
    const fake: Fake = { orders: [], redeemed: [], balance: 0 };
    const venue = new PolymarketVenue(account, creds, { readOnly: true }, fakeAdapter(fake));
    const snap = await venue.snapshot([market], ["yes1"]);
    assert.equal((await venue.buy(buyAction, market, snap)).ok, false);
    assert.equal((await venue.sell({ kind: "sell", conditionId: "0xcond1", tokenId: "yes1", shares: 40, minPrice: 0.9, why: "closed", reason: "r" }, market)).ok, false);
    assert.equal((await venue.redeem({ kind: "redeem", conditionId: "0xcond1", tokenId: "yes1", reason: "r" }, market, snap)).ok, false);
    assert.deepEqual([fake.orders.length, fake.redeemed.length], [0, 0]);
  });

  it("redeems by condition", async () => {
    const fake: Fake = { orders: [], redeemed: [], balance: 0 };
    const venue = new PolymarketVenue(account, creds, {}, fakeAdapter(fake));
    const snap = await venue.snapshot([market], ["yes1"]);
    const result = await venue.redeem({ kind: "redeem", conditionId: "0xcond1", tokenId: "yes1", reason: "Resolved." }, market, snap);
    assert.equal(result.ok, true);
    assert.deepEqual(fake.redeemed, ["0xcond1"]);
    assert.deepEqual([result.trade?.action, result.trade?.price], ["redeem", null]);
  });
});

describe("geoblock", () => {
  it("reads blocked and country, and returns null when the answer cannot be read", async () => {
    const blocked = (async () => new Response(JSON.stringify({ blocked: true, country: "US" }), { status: 200 })) as unknown as typeof fetch;
    const broken = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    assert.deepEqual(await polymarketGeoblock(blocked), { blocked: true, country: "US" });
    assert.equal(await polymarketGeoblock(broken), null);
  });
});
