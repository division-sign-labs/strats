import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIFI_DIAMOND, QuoteSchema, checkQuote, fetchQuote, fetchStatus, floorFrom, priceImpactPct, quoteUrl, readStatus, type QuoteExpectation } from "../src/buyback/lifi.js";

const WALLET = `0x${"a1".repeat(20)}`;
const DEST = `0x${"d2".repeat(20)}`;
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const TOKEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const HASH = `0x${"c8".repeat(32)}`;

// Shaped like a live answer from li.quest/v1/quote, read on 2026-09-19 (Arbitrum USDC to a Base token).
const rawQuote = () => ({
  type: "lifi", tool: "layerswap",
  action: {
    fromToken: { address: USDC, chainId: 42161, symbol: "USDC", decimals: 6, name: "USD Coin", priceUSD: "0.9983" },
    fromAmount: "196470000",
    toToken: { address: TOKEN, chainId: 8453, symbol: "DEGEN", decimals: 18, name: "Degen", priceUSD: "0.00108" },
    fromChainId: 42161, toChainId: 8453, slippage: 0.01, fromAddress: WALLET.toLowerCase(), toAddress: DEST.toLowerCase(),
  },
  estimate: {
    tool: "layerswap", approvalAddress: DIAMOND, toAmountMin: "176406395059151920000000", toAmount: "178188277837527200000000", fromAmount: "196470000",
    feeCosts: [{ name: "LIFI Fixed Fee", amount: "491175", amountUSD: "0.4904", included: true }, { name: "LayerSwap fee", amount: "47241", amountUSD: "0.047227", included: true }],
    gasCosts: [{ type: "SEND", amount: "11704308000000", amountUSD: "0.0307", token: { symbol: "ETH" } }],
    executionDuration: 11, fromAmountUSD: "196.1502", toAmountUSD: "194.0999",
  },
  includedSteps: [{ type: "protocol", tool: "feeCollection" }, { type: "cross", tool: "layerswap" }],
  transactionRequest: { value: "0x0", to: DIAMOND, data: "0x4c279d6b0000", from: WALLET.toLowerCase(), chainId: 42161, gasPrice: "0x13255e0", gasLimit: "0x337da4" },
});
type Raw = ReturnType<typeof rawQuote>;
const quote = (change: (q: Raw) => void = () => undefined) => {
  const raw = rawQuote();
  change(raw);
  return QuoteSchema.parse(raw);
};
const expect = (over: Partial<QuoteExpectation> = {}): QuoteExpectation => ({
  fromChainId: 42161, toChainId: 8453, fromToken: USDC, toToken: TOKEN, fromAmount: 196_470_000n, fromAddress: WALLET, toAddress: DEST, slippagePct: 1, maxImpactPct: 3, ...over,
});

describe("the pinned LI.FI contract", () => {
  it("is the same published address on both source chains, and nothing else is listed", () => {
    assert.deepEqual(Object.keys(LIFI_DIAMOND).sort(), ["137", "42161"]);
    assert.equal(LIFI_DIAMOND[42161], DIAMOND);
    assert.equal(LIFI_DIAMOND[137], DIAMOND);
  });
});

describe("checkQuote", () => {
  it("accepts a quote that is ours in every respect, comparing addresses without regard to case", () => {
    assert.deepEqual(checkQuote(quote(), expect()), []);
    assert.deepEqual(checkQuote(quote(), expect({ fromToken: USDC.toLowerCase(), toToken: TOKEN.toUpperCase().replace("0X", "0x") })), []);
  });

  const rejections: Array<[string, (q: Raw) => void, RegExp]> = [
    ["a different source chain", (q) => { q.action.fromChainId = 137; }, /starts on a different chain/],
    ["a different source token", (q) => { q.action.fromToken.address = TOKEN; }, /spends a different token/],
    ["a different amount", (q) => { q.action.fromAmount = "196470001"; }, /different amount/],
    ["a different destination chain", (q) => { q.action.toChainId = 1; }, /ends on a different chain/],
    ["a different token bought", (q) => { q.action.toToken.address = USDC; }, /buys a different token/],
    ["a different sender", (q) => { q.action.fromAddress = DEST; }, /spends from a different wallet/],
    ["a different receiver", (q) => { q.action.toAddress = WALLET; }, /delivers to a different address/],
    ["an approval to another contract", (q) => { q.estimate.approvalAddress = DEST; }, /approve a contract that is not the pinned/],
    ["a transaction to another contract", (q) => { q.transactionRequest.to = DEST; }, /goes to a contract that is not the pinned/],
    ["a transaction written for another sender", (q) => { q.transactionRequest.from = DEST; }, /different sender/],
    ["a transaction for another chain", (q) => { q.transactionRequest.chainId = 137; }, /transaction is for a different chain/],
    ["a transaction that carries native value", (q) => { q.transactionRequest.value = "0x1"; }, /gas coin/],
    ["a transaction with no call", (q) => { q.transactionRequest.data = "0x"; }, /carries no call/],
    ["a minimum of zero", (q) => { q.estimate.toAmountMin = "0"; }, /promises nothing/],
    ["too much price impact", (q) => { q.estimate.toAmountUSD = "189.00"; }, /price impact is 3\.6%, above the limit of 3%/],
    ["missing dollar figures", (q) => { delete (q.estimate as Partial<Raw["estimate"]>).toAmountUSD; }, /cannot be checked/],
    ["a different slippage", (q) => { q.action.slippage = 0.03; }, /different slippage/],
  ];
  for (const [name, change, pattern] of rejections) {
    it(`rejects ${name}`, () => {
      const failures = checkQuote(quote(change), expect());
      assert.equal(failures.length, 1, failures.join(" | "));
      assert.match(failures[0]!, pattern);
    });
  }

  it("rejects a quote that promises less than the floor, and accepts one exactly at it", () => {
    const min = BigInt(rawQuote().estimate.toAmountMin);
    assert.match(checkQuote(quote(), expect({ floorMinOut: min + 1n }))[0]!, /promises less than the least you agreed to/);
    assert.deepEqual(checkQuote(quote(), expect({ floorMinOut: min })), []);
  });

  it("has no pinned contract for any other source chain, so nothing from there is ever accepted", () => {
    assert.match(checkQuote(quote(), expect({ fromChainId: 10 }))[0]!, /no pinned LI\.FI contract/);
  });

  it("lists every failed check, not only the first", () => {
    const failures = checkQuote(quote((q) => { q.action.toAddress = WALLET; q.transactionRequest.to = DEST; q.transactionRequest.value = "0x5"; }), expect());
    assert.equal(failures.length, 3);
  });

  it("measures price impact from LI.FI's dollar figures, and the floor as 98% of the quoted minimum", () => {
    assert.ok(Math.abs(priceImpactPct(quote()) - 1.0453) < 0.001);
    assert.equal(floorFrom(quote()), (176406395059151920000000n * 98n) / 100n);
  });
});

const respond = (status: number, body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const request = expect();

describe("fetchQuote", () => {
  it("asks for exactly our amount, tokens, addresses and slippage", () => {
    const url = new URL(quoteUrl(request));
    assert.equal(url.origin + url.pathname, "https://li.quest/v1/quote");
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      fromChain: "42161", toChain: "8453", fromToken: USDC, toToken: TOKEN, fromAmount: "196470000", fromAddress: WALLET, toAddress: DEST, slippage: "0.01", integrator: "strats",
    });
  });

  it("returns the parsed quote", async () => {
    const result = await fetchQuote(request, respond(200, rawQuote()));
    assert.ok(result.ok);
    assert.equal(result.quote.estimate.toAmountMin, "176406395059151920000000");
  });

  it("says there is no route on a 404 or a refused token, and never throws", async () => {
    const none = await fetchQuote(request, respond(404, { message: "No available quotes for the requested transfer", code: 1002 }));
    assert.ok(!none.ok && none.kind === "no-route");
    const denied = await fetchQuote(request, respond(400, { message: "Token 8453-0x11 is invalid or in deny list.", code: 1011 }));
    assert.ok(!denied.ok && denied.kind === "no-route");
    assert.match(denied.message, /deny list/);
    const down = await fetchQuote(request, (async () => { throw new Error("socket"); }) as unknown as typeof fetch);
    assert.ok(!down.ok && down.kind === "unavailable");
    const busy = await fetchQuote(request, respond(429, {}));
    assert.ok(!busy.ok && busy.kind === "unavailable");
  });

  it("refuses an answer without the fields the checks need", async () => {
    const { transactionRequest: _tx, ...noTx } = rawQuote();
    const result = await fetchQuote(request, respond(200, noTx));
    assert.ok(!result.ok && result.kind === "invalid");
    assert.match(result.message, /transactionRequest/);
  });
});

// Shaped like a live answer from li.quest/v1/status for a finished transfer, read on 2026-09-19.
const statusBody = (over: Record<string, unknown> = {}) => ({
  transactionId: `0x${"30".repeat(32)}`,
  sending: { txHash: HASH, chainId: 42161, amount: "196470000" },
  receiving: { txHash: `0x${"9f".repeat(32)}`, chainId: 8453, amount: "177000000000000000000000", token: { address: TOKEN, symbol: "DEGEN", decimals: 18 } },
  fromAddress: WALLET.toLowerCase(), toAddress: DEST.toLowerCase(), tool: "layerswap", status: "DONE", substatus: "COMPLETED", substatusMessage: "The transfer is complete.",
  ...over,
});
const expectStatus = { txHash: HASH, fromChainId: 42161, toChainId: 8453, toToken: TOKEN, toAddress: DEST };

describe("readStatus", () => {
  it("reads a finished swap and what arrived", () => {
    assert.deepEqual(readStatus(statusBody(), expectStatus), { state: "done", received: "177000000000000000000000", tool: "layerswap", receivingTxHash: `0x${"9f".repeat(32)}` });
  });

  it("never trusts an answer about another transaction", () => {
    const other = readStatus(statusBody({ sending: { txHash: `0x${"ee".repeat(32)}` } }), expectStatus);
    assert.equal(other.state, "pending");
    assert.equal(readStatus(statusBody({ sending: {} }), expectStatus).state, "pending");
    assert.equal(readStatus("nonsense", expectStatus).state, "pending");
  });

  it("keeps waiting while LI.FI says pending or not found", () => {
    assert.equal(readStatus(statusBody({ status: "PENDING", substatus: "WAIT_DESTINATION_TRANSACTION" }), expectStatus).state, "pending");
    assert.equal(readStatus(statusBody({ status: "NOT_FOUND" }), expectStatus).state, "pending");
  });

  it("tells a failure and a refund apart from a purchase", () => {
    assert.equal(readStatus(statusBody({ status: "FAILED", substatusMessage: "The transfer failed." }), expectStatus).state, "failed");
    assert.equal(readStatus(statusBody({ substatus: "REFUNDED" }), expectStatus).state, "refunded");
  });

  it("does not count a route that delivered another token, another chain or another address as a purchase", () => {
    assert.equal(readStatus(statusBody({ substatus: "PARTIAL" }), expectStatus).state, "other-token");
    const usdc = statusBody();
    usdc.receiving.token.address = USDC;
    assert.equal(readStatus(usdc, expectStatus).state, "other-token");
    assert.equal(readStatus(statusBody({ toAddress: WALLET }), expectStatus).state, "other-token");
    const chain = statusBody();
    chain.receiving.chainId = 1;
    assert.equal(readStatus(chain, expectStatus).state, "other-token");
  });

  it("treats a 404 and a network failure as not known yet", async () => {
    assert.equal((await fetchStatus(expectStatus, respond(404, { message: "not found", code: 1003 }))).state, "pending");
    assert.equal((await fetchStatus(expectStatus, (async () => { throw new Error("socket"); }) as unknown as typeof fetch)).state, "pending");
    assert.equal((await fetchStatus(expectStatus, respond(200, statusBody()))).state, "done");
  });
});
