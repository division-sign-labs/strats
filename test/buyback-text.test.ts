import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseArgs, UsageError } from "../src/args.js";
import { QuoteSchema, floorFrom } from "../src/buyback/lifi.js";
import { planBuyback } from "../src/buyback/plan.js";
import { CONFIRM_QUESTION, DRY_RUN_FOOTER, renderConfirmation, renderHeader, renderProfit, renderQuote, renderRoute, renderSplit, routeTools, type RouteContext } from "../src/buyback/text.js";
import { buyback } from "../src/commands/buyback.js";
import { RUNTIME_CREDS_ENV } from "../src/runtime-creds.js";
import type { Prompts } from "../src/setup.js";

const WALLET = `0x${"a1".repeat(20)}`;
const TOKEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";

const quote = QuoteSchema.parse({
  tool: "relay",
  action: { fromChainId: 42161, toChainId: 8453, fromToken: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", chainId: 42161, symbol: "USDC", decimals: 6 }, toToken: { address: TOKEN, chainId: 8453, symbol: "TKN", decimals: 18 }, fromAmount: "196470000", fromAddress: WALLET, toAddress: WALLET, slippage: 0.01 },
  estimate: {
    approvalAddress: DIAMOND, toAmount: "1204551000000000000000000", toAmountMin: "1192505490000000000000000", fromAmountUSD: "196.47", toAmountUSD: "194.90", executionDuration: 11,
    feeCosts: [{ name: "LI.FI", amountUSD: "0.49", included: true }, { name: "relayer", amountUSD: "0.20", included: true }],
    gasCosts: [{ amount: "11704308000000", amountUSD: "0.03", token: { symbol: "ETH" } }],
  },
  includedSteps: [{ type: "protocol", tool: "feeCollection" }, { type: "cross", tool: "relay" }],
  transactionRequest: { to: DIAMOND, from: WALLET, chainId: 42161, data: "0xabcdef", value: "0x0" },
});
const ctx = (over: Partial<RouteContext> = {}): RouteContext => ({
  botId: "strats", venueLabel: "Hyperliquid", sourceSymbol: "USDC", sourceChain: "Arbitrum", sourceChainId: 42161, nativeSymbol: "ETH", walletAddress: WALLET,
  token: { chainId: 8453, address: TOKEN }, destination: WALLET, destinationIsWallet: true, split: { buybackPct: 70, keepPct: 30 }, earlierBuybacks: 2, slippagePct: 1, maxImpactPct: 3, ...over,
});
const plan = planBuyback({ venue: "hyperliquid", equityUsd: 1482.1, basisUsd: 1000, settledUsd: 200, freeUsd: 1482.1, buybackPct: 70, minUsd: 25 });

describe("the dry-run plan", () => {
  it("opens by saying nothing is signed or sent, and ends by naming --execute", () => {
    assert.deepEqual(renderHeader("strats", true), ['Buyback for bot "strats". Dry run: nothing is signed or sent.', ""]);
    assert.deepEqual(renderHeader("strats", false), ['Buyback for bot "strats".', ""]);
    assert.equal(DRY_RUN_FOOTER, "Nothing was sent. To carry it out: strats buyback --execute");
  });

  it("always shows what profit is measured from", () => {
    assert.deepEqual(renderProfit(plan, ctx()), [
      "Profit",
      "  Wallet value now        $1,482.10 on Hyperliquid",
      "  Deposits less withdrawals  $1,000.00",
      "  Profit so far           $482.10",
      "  Already split           $200.00 in 2 earlier buybacks",
      "  Profit to split now     $282.10",
      "",
    ]);
    assert.equal(renderProfit({ ...plan, settledUsd: 0 }, ctx({ earlierBuybacks: 0 }))[4], "  Already split           $0.00, no earlier buybacks");
    assert.equal(renderProfit(plan, ctx({ earlierBuybacks: 1 }))[4], "  Already split           $200.00 in 1 earlier buyback");
  });

  it("shows the pinned split, and says so when only part of the share is free", () => {
    assert.deepEqual(renderSplit(plan, ctx()), [
      "Split, pinned on this machine",
      "  70% buys the token      $197.47",
      "  30% is kept             $84.63 stays in the Hyperliquid account",
      "",
    ]);
    const tight = planBuyback({ venue: "hyperliquid", equityUsd: 1482.1, basisUsd: 1000, settledUsd: 200, freeUsd: 100, buybackPct: 70, minUsd: 25 });
    assert.equal(renderSplit(tight, ctx())[3], "  Only $100.00 is free; the rest is in open positions. This buyback uses $100.00.");
  });

  it("lays out the route step by step for Hyperliquid", () => {
    assert.deepEqual(renderRoute(plan, quote, ctx()), [
      "Route",
      `  1. Withdraw $197.47 USDC from Hyperliquid to your wallet ${WALLET} on Arbitrum. Hyperliquid keeps $1.00, so $196.47 arrives. About 5 minutes.`,
      "  2. Approve exactly 196.47 USDC to LI.FI (0x1231…4EaE) on Arbitrum.",
      `  3. Swap 196.47 USDC on Arbitrum for TKN (${TOKEN}) on Base, through LI.FI (relay). About 11 seconds.`,
      `  Tokens go to            ${WALLET} on Base (this bot's own wallet)`,
      "",
    ]);
  });

  it("words the Polymarket route with pUSD, Polygon and no fee, and names a pinned destination as pinned", () => {
    const pm = planBuyback({ venue: "polymarket", equityUsd: 1482.1, basisUsd: 1000, settledUsd: 200, freeUsd: 1482.1, buybackPct: 70, minUsd: 25 });
    const dest = `0x${"d2".repeat(20)}`;
    const lines = renderRoute(pm, quote, ctx({ venueLabel: "Polymarket", sourceSymbol: "pUSD", sourceChain: "Polygon", sourceChainId: 137, nativeSymbol: "POL", destination: dest, destinationIsWallet: false }));
    assert.equal(lines[1], `  1. Withdraw $197.47 pUSD from the Polymarket deposit wallet to your wallet ${WALLET} on Polygon. No fee.`);
    assert.equal(lines[2], "  2. Approve exactly 197.47 pUSD to LI.FI (0x1231…4EaE) on Polygon.");
    assert.equal(lines[4], `  Tokens go to            ${dest} on Base (the address you pinned)`);
    assert.equal(renderSplit(pm, ctx({ venueLabel: "Polymarket" }))[2], "  30% is kept             $84.63 stays in the Polymarket deposit wallet");
  });

  it("shows the live quote, its fees, and whether the wallet can pay for gas", () => {
    const at = new Date(2026, 8, 19, 14, 2, 11);
    assert.deepEqual(renderQuote(plan, quote, ctx(), { heldText: "0.0021", enough: true, shortfallText: "0" }, at), [
      "Quote, live at 14:02:11",
      "  You receive about       1,204,551 TKN ($194.90)",
      "  You receive at least    1,192,505 TKN with 1% slippage allowed",
      "  Price impact            0.8% (limit 3%)",
      "  Fees                    Hyperliquid withdrawal $1.00; LI.FI $0.49; relayer $0.20; gas about $0.03 in ETH on Arbitrum",
      "  Gas                     the wallet holds 0.0021 ETH on Arbitrum, enough",
      "",
    ]);
    const short = renderQuote(plan, quote, ctx(), { heldText: "0.0000", enough: false, shortfallText: "0.001" }, at);
    assert.equal(short[5], `  Gas                     the wallet holds 0.0000 ETH on Arbitrum, not enough: send about 0.001 ETH on Arbitrum to ${WALLET} first`);
  });

  it("names the tools that move the money, not LI.FI's own fee step", () => {
    assert.equal(routeTools(quote), "relay");
    assert.equal(routeTools({ ...quote, includedSteps: [{ type: "protocol", tool: "feeCollection" }, { type: "swap", tool: "okx" }, { type: "cross", tool: "mayan" }] }), "okx + mayan");
    assert.equal(routeTools({ ...quote, includedSteps: [] }), "relay");
  });
});

describe("the confirmation", () => {
  it("says that it moves real money, what, where to, the least accepted, and the fees", () => {
    assert.deepEqual(renderConfirmation(plan, quote, ctx(), floorFrom(quote)), [
      "This moves real money.",
      "  Withdraw    $197.47 USDC from Hyperliquid (fee $1.00)",
      `  Swap        196.47 USDC on Arbitrum for TKN ${TOKEN} on Base (chain 8453)`,
      `  Send to     ${WALLET} (this bot's own wallet)`,
      "  At least    1,168,655 TKN. The price is checked again after the withdrawal arrives; if it promises less, the swap is not sent and the USDC stays in your wallet.",
      "  Fees        Hyperliquid $1.00; LI.FI $0.49; relayer $0.20; gas about $0.03",
    ]);
    assert.equal(CONFIRM_QUESTION, "Go ahead? (y/N)");
  });

  it("leaves the withdrawal out once it has arrived", () => {
    const lines = renderConfirmation(plan, quote, ctx(), floorFrom(quote), false);
    assert.equal(lines.some((l) => l.includes("Withdraw")), false);
    assert.match(lines[3]!, /checked again just before the swap is signed/);
    assert.equal(lines[4], "  Fees        LI.FI $0.49; relayer $0.20; gas about $0.03");
  });
});

const prompts = (interactive: boolean): Prompts => ({ interactive, interruptMessage: "", ask: async () => { throw new Error("asked"); }, confirm: async () => { throw new Error("asked"); }, close: () => undefined }) as unknown as Prompts;

describe("strats buyback, before anything is read", () => {
  it("refuses --execute without a terminal, with -y or without it", async () => {
    for (const argv of [["buyback", "--execute"], ["buyback", "--execute", "-y"]]) {
      await assert.rejects(() => buyback(parseArgs(argv), prompts(false)), (error: unknown) => error instanceof UsageError && error.message === "strats buyback --execute asks a question and needs a terminal.");
    }
  });

  it("has no way to answer the question from a flag: the command never looks at -y", () => {
    const source = readFileSync(new URL("../src/commands/buyback.ts", import.meta.url), "utf8");
    assert.equal(/flags\.has\("yes"\)/.test(source), false);
    assert.equal(/STRATS_YES|process\.env\.[A-Z_]*CONFIRM/.test(source), false);
    const machine = readFileSync(new URL("../src/buyback/machine.ts", import.meta.url), "utf8");
    assert.equal(/flags|process\.env/.test(machine), false);
  });

  it("never asks Quotient for settings: the token, the split and the destination come from this machine", () => {
    for (const file of ["../src/commands/buyback.ts", "../src/buyback/machine.ts", "../src/buyback/venues.ts", "../src/buyback/lifi.ts", "../src/buyback/chain.ts", "../src/buyback/plan.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.equal(/fetchConfig|fetchThemeConfig|fetchTeamConfig|fetchConfigFor|discoverConfig|fetchThemeTargets|fetchTeamTargets/.test(source), false, file);
    }
  });

  it("checks the flag bounds", async () => {
    const bad = [["--min-usd", "9"], ["--min-usd", "x"], ["--slippage", "0"], ["--slippage", "5.1"], ["--max-impact", "0"], ["--max-impact", "11"]];
    for (const flags of bad) await assert.rejects(() => buyback(parseArgs(["buyback", ...flags]), prompts(true)), UsageError, flags.join(" "));
    await assert.rejects(() => buyback(parseArgs(["buyback", "--execute", "--sync"]), prompts(true)), UsageError);
    await assert.rejects(() => buyback(parseArgs(["buyback", "--dry-run"]), prompts(true)), UsageError);
  });

  it("refuses to run on a droplet", async () => {
    const saved = process.env[RUNTIME_CREDS_ENV];
    process.env[RUNTIME_CREDS_ENV] = "anything";
    try {
      await assert.rejects(() => buyback(parseArgs(["buyback"]), prompts(true)), /runs on your own machine, not on the droplet/);
      assert.equal(process.env[RUNTIME_CREDS_ENV], "anything", "the value was not even decoded");
    } finally {
      if (saved === undefined) delete process.env[RUNTIME_CREDS_ENV]; else process.env[RUNTIME_CREDS_ENV] = saved;
    }
  });
});
