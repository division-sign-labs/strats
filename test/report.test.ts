import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { discoverConfig, postReport } from "../src/client.js";
import { REPORT_MAX_BYTES, ReportSchema, encodeReport, type Report, type ReportPosition, type ReportTrade, type ThemeMarket } from "../src/protocol/index.js";
import {
  PROMPT_REPORT_INTERVAL_MS, REPORT_INTERVAL_MS, Reporter, assetLabel, buildReport, hyperliquidPositions, polymarketPositions,
  publishedWalletAddress, sanitizeAction, sanitizeLabel, shortWord, toReportPosition, toReportTrade, totalsOnly,
} from "../src/report.js";
import { loadRuntimeState } from "../src/runtime-state.js";

const API_KEY = `qsk_${"test".repeat(3)}`;
const figures = { venue: "polymarket" as const, equityUsd: 1234.567, netDepositsUsd: 1000, volumeUsd: 4321.009, openPositions: 3 };
const MASTER = `0x${"a1".repeat(20)}`;
const FUNDER = `0x${"f1".repeat(20)}`;
const T0 = Date.parse("2026-09-19T12:00:00.000Z");
const position = (over: Partial<ReportPosition> = {}): ReportPosition => ({ label: "Bitcoin", venue: "hyperliquid", side: "long", sizeUsd: 990, entryPrice: 100_004, markPrice: 100_000, pnlUsd: -0.04, ...over });
const trade = (minutesAgo: number, over: Partial<ReportTrade> = {}): ReportTrade => ({ at: new Date(T0 - minutesAgo * 60_000).toISOString(), label: "Bitcoin", action: "open", sizeUsd: 990, price: 100_004, ...over });
const market = (n: number, outcomes: [string, string] = ["Yes", "No"]): ThemeMarket => ({ conditionId: `0xcond${n}`, tokenIds: [`yes${n}`, `no${n}`], outcomes, side: 0, question: `Will thing ${n} happen?`, marketKey: null });
const account = { positionPct: 10, token: { chainId: 8453, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, split: { buybackPct: 70, keepPct: 30 } };

describe("report", () => {
  it("matches the protocol, rounds to cents, and reports zero bought back", () => {
    const report = buildReport(figures, "Bought 200 Yes at 0.500.", Date.parse("2026-09-19T12:00:00.000Z"));
    assert.equal(ReportSchema.safeParse(report).success, true);
    assert.deepEqual(report, { v: 1, at: "2026-09-19T12:00:00.000Z", venue: "polymarket", equityUsd: 1234.57, netDepositsUsd: 1000, profitUsd: 234.57, volumeUsd: 4321.01, boughtBackUsd: 0, openPositions: 3, lastAction: "Bought 200 Yes at 0.500." });
  });

  it("reports a loss as a negative profit", () => {
    assert.equal(buildReport({ ...figures, equityUsd: 900 }, "", 0).profitUsd, -100);
  });

  it("never carries an address or a transaction hash, and keeps lastAction within 200 characters", () => {
    const address = `0x${"ab".repeat(20)}`;
    const hash = `0x${"cd".repeat(32)}`;
    const text = sanitizeAction(`Redeemed for ${address} (transaction ${hash}). ${"x".repeat(300)}`);
    assert.ok(!text.includes(address) && !text.includes(hash));
    assert.equal(text.length, 200);
    assert.equal(JSON.stringify(buildReport(figures, `wallet ${address}`, 0)).includes(address), false);
    assert.equal(sanitizeAction(`key ${API_KEY} rejected`), "key [key] rejected");
  });
});

describe("report positions", () => {
  it("maps a Hyperliquid position from the cycle's snapshot, with null where the venue gave no number", () => {
    const rows = hyperliquidPositions({ side: "LONG", size: 0.0099, avgPrice: 100_004, unrealizedPnl: -0.0396 }, 100_000, "Bitcoin");
    assert.deepEqual(rows, [{ label: "Bitcoin", venue: "hyperliquid", side: "long", sizeUsd: 990, entryPrice: 100_004, markPrice: 100_000, pnlUsd: -0.04 }]);
    assert.deepEqual(hyperliquidPositions({ side: "SHORT", size: 2, avgPrice: 50 }, 0, "Gold")[0], { label: "Gold", venue: "hyperliquid", side: "short", sizeUsd: 100, entryPrice: 50, markPrice: null, pnlUsd: null });
    assert.deepEqual(hyperliquidPositions(null, 100_000, "Bitcoin"), []);
  });

  it("names a Hyperliquid asset in plain words and falls back to the coin's ticker", () => {
    assert.equal(assetLabel({ assetKey: "crypto:btc", coin: "BTC" }), "Bitcoin");
    assert.equal(assetLabel({ assetKey: "company:nvda", coin: "xyz:NVDA" }), "NVIDIA");
    assert.equal(assetLabel({ assetKey: "company:unknown", coin: "xyz:abcd" }), "ABCD");
    assert.equal(assetLabel({ name: "Served by the server", assetKey: "crypto:btc", coin: "BTC" }), "Served by the server");
  });

  it("maps Polymarket holdings to the market question and the outcome bought, largest first, configured markets only", () => {
    const rows = polymarketPositions([
      { tokenId: "yes1", size: 40, avgPrice: 0.4, valueUsd: 20 },
      { tokenId: "no2", size: 100, avgPrice: 0, valueUsd: 48 },
      { tokenId: "stranger", size: 9, avgPrice: 0.5, valueUsd: 900 },
    ], [market(1), market(2, ["Lakers", "Celtics (away)"])]);
    assert.deepEqual(rows, [
      // Found by a direct balance read: no entry price, so no profit figure either.
      { label: "Will thing 2 happen?", venue: "polymarket", side: "Celtics away", sizeUsd: 48, entryPrice: null, markPrice: 0.48, pnlUsd: null },
      { label: "Will thing 1 happen?", venue: "polymarket", side: "Yes", sizeUsd: 20, entryPrice: 0.4, markPrice: 0.5, pnlUsd: 4 },
    ]);
  });

  it("bounds positions at 20 and trades at 30, newest first", () => {
    const holdings = Array.from({ length: 25 }, (_, i) => ({ tokenId: `yes${i}`, size: 10, avgPrice: 0.5, valueUsd: 5 + i }));
    const markets = Array.from({ length: 25 }, (_, i) => market(i));
    assert.equal(polymarketPositions(holdings, markets).length, 20);
    assert.equal(polymarketPositions(holdings, markets)[0]!.sizeUsd, 29);

    const trades = Array.from({ length: 40 }, (_, i) => trade(40 - i));
    const report = buildReport({ ...figures, positions: Array.from({ length: 25 }, () => position()), trades }, "x", T0);
    assert.equal(report.positions!.length, 20);
    assert.equal(report.trades!.length, 30);
    assert.equal(report.trades![0]!.at, trade(1).at);
    assert.ok(report.trades!.every((t, i, all) => i === 0 || Date.parse(all[i - 1]!.at) >= Date.parse(t.at)));
    assert.equal(encodeReport(report).ok, true);
  });

  it("keeps labels to 80 plain characters with nothing shaped like an address or a key, and tags to 12", () => {
    const label = sanitizeLabel(`Will ${MASTER} or qsk_${"k".repeat(20)} win?\n${"x".repeat(200)}`, "fallback");
    assert.equal(label.length, 80);
    assert.ok(!label.includes("0x") && !label.includes("qsk_"));
    assert.equal(sanitizeLabel(MASTER, "Bitcoin"), "Bitcoin");
    assert.equal(shortWord("Über-long outcome name (2026)", "outcome"), "ber-long out");
    assert.equal(shortWord("%%%", "outcome"), "outcome");
    assert.equal(toReportPosition({ label: "x", venue: "polymarket", side: "Yes", sizeUsd: Number.NaN }), null);
    assert.equal(toReportTrade({ at: Number.NaN, label: "x", action: "buy", sizeUsd: 1 }), null);
    assert.deepEqual(toReportTrade({ at: T0, label: "Will it happen?", action: "buy", sizeUsd: 100.004, price: 0.5 }), { at: "2026-09-19T12:00:00.000Z", label: "Will it happen?", action: "buy", sizeUsd: 100, price: 0.5 });
  });
});

describe("wallet address", () => {
  const stock = { strategyId: "stock-ls" as const, masterAddress: MASTER };
  const theme = { strategyId: "theme" as const, masterAddress: MASTER, polymarket: { signerAddress: MASTER, funder: FUNDER, signatureType: 3 } };

  it("is absent unless the creator opted in", () => {
    assert.equal(publishedWalletAddress(stock), undefined);
    assert.equal(publishedWalletAddress({ ...stock, publishWallet: false }), undefined);
    assert.equal(publishedWalletAddress({ ...theme, publishWallet: false }), undefined);
    const report = buildReport({ ...figures, positions: [position()], trades: [trade(1)], walletAddress: publishedWalletAddress(stock) }, `wallet ${MASTER}`, T0);
    assert.equal("walletAddress" in report, false);
    assert.ok(!JSON.stringify(report).toLowerCase().includes(MASTER.toLowerCase()));
  });

  it("is the Hyperliquid wallet for a single-asset bot and the Polymarket deposit wallet for a theme bot", () => {
    assert.equal(publishedWalletAddress({ ...stock, publishWallet: true }), MASTER);
    assert.equal(publishedWalletAddress({ ...theme, publishWallet: true }), FUNDER);
    const report = buildReport({ ...figures, walletAddress: publishedWalletAddress({ ...theme, publishWallet: true }) }, "x", T0);
    assert.equal(report.walletAddress, FUNDER);
    assert.equal(ReportSchema.safeParse(report).success, true);
    // The signing address of a theme bot is never the one published.
    assert.ok(!JSON.stringify(report).includes(MASTER));
  });
});

describe("a malformed or oversized report", () => {
  const good = buildReport({ ...figures, positions: [position()], trades: [trade(1)] }, "x", T0);

  it("is refused by the local check", () => {
    assert.equal(encodeReport(good).ok, true);
    const bad: Array<Record<string, unknown>> = [
      { ...good, positions: [position({ label: "" })] },
      { ...good, positions: [position({ label: "x".repeat(81) })] },
      { ...good, positions: [position({ side: "<b>long</b>" })] },
      { ...good, positions: [position({ sizeUsd: -1 })] },
      { ...good, positions: [{ ...position(), tokenId: "123" }] },
      { ...good, positions: Array.from({ length: 21 }, () => position()) },
      { ...good, trades: Array.from({ length: 31 }, () => trade(1)) },
      { ...good, trades: [trade(1, { at: "yesterday" })] },
      { ...good, trades: [trade(1, { price: Number.POSITIVE_INFINITY })] },
      { ...good, walletAddress: "0x1234" },
      { ...good, signerPk: `0x${"b2".repeat(32)}` },
    ];
    for (const report of bad) assert.equal(encodeReport(report).ok, false, JSON.stringify(report).slice(0, 120));
  });

  it("is refused when it is larger than the gateway accepts", () => {
    // Control characters cost six bytes each in JSON. The builder removes them; the check does not rely on that.
    const heavy = "\u0001".repeat(80);
    const big = { ...good, positions: Array.from({ length: 20 }, () => position({ label: heavy })), trades: Array.from({ length: 30 }, () => trade(1, { label: heavy })) };
    assert.equal(ReportSchema.safeParse(big).success, true);
    assert.ok(Buffer.byteLength(JSON.stringify(big)) > REPORT_MAX_BYTES);
    const result = encodeReport(big);
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /bytes/);
  });

  it("is never sent", async () => {
    let posts = 0;
    const fetchImpl = (async () => { posts += 1; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const result = await postReport({ gatewayUrl: "https://gw.example", apiKey: API_KEY, fetchImpl }, "theme", { ...good, positions: [position({ label: "" })] } as Report);
    assert.equal(result.ok, false);
    assert.equal(posts, 0);
  });
});

describe("postReport", () => {
  it("POSTs the report with the API key header to the strategy's reports path", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await postReport({ gatewayUrl: "https://gw.example", apiKey: API_KEY, fetchImpl }, "theme", buildReport(figures, "x", 0));
    assert.deepEqual(result, { ok: true });
    assert.equal(calls[0]!.url, "https://gw.example/api/v1/strategies/theme/reports");
    assert.equal(calls[0]!.init.method, "POST");
    assert.equal((calls[0]!.init.headers as Record<string, string>)["x-quotient-api-key"], API_KEY);
    assert.deepEqual(Object.keys(JSON.parse(String(calls[0]!.init.body))).sort(), ["at", "boughtBackUsd", "equityUsd", "lastAction", "netDepositsUsd", "openPositions", "profitUsd", "v", "venue", "volumeUsd"]);
  });

  it("never throws: a network error and a 500 both come back as a result", async () => {
    const boom = (async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch;
    const down = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    assert.deepEqual(await postReport({ gatewayUrl: "https://gw.example", apiKey: API_KEY, fetchImpl: boom }, "stock-ls", buildReport(figures, "x", 0)), { ok: false, message: "network error" });
    assert.deepEqual(await postReport({ gatewayUrl: "https://gw.example", apiKey: API_KEY, fetchImpl: down }, "stock-ls", buildReport(figures, "x", 0)), { ok: false, status: 500, message: "the gateway answered 500" });
  });
});

describe("Reporter", () => {
  let home: string;
  const savedHome = process.env.STRATS_HOME;
  before(() => {
    home = mkdtempSync(join(tmpdir(), "strats-report-"));
    process.env.STRATS_HOME = home;
  });
  after(() => {
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.STRATS_HOME; else process.env.STRATS_HOME = savedHome;
  });

  it("sends at most once per five minutes, swallows failures into one line, and can be switched off", async () => {
    let posts = 0;
    let status = 200;
    const fetchImpl = (async () => {
      posts += 1;
      return new Response("{}", { status });
    }) as unknown as typeof fetch;
    const gateway = { gatewayUrl: "https://gw.example", apiKey: API_KEY, fetchImpl };
    const reporter = new Reporter(gateway, "theme", "alpha", true);
    const t0 = Date.parse("2026-09-19T12:00:00.000Z");
    assert.equal(await reporter.maybeSend(t0, "a", async () => figures), null);
    assert.equal(await reporter.maybeSend(t0 + 60_000, "a", async () => figures), null);
    assert.equal(posts, 1);
    assert.equal(loadRuntimeState("alpha").lastReportAt, "2026-09-19T12:00:00.000Z");

    status = 503;
    assert.match((await reporter.maybeSend(t0 + REPORT_INTERVAL_MS, "a", async () => figures)) ?? "", /^The report was not sent .* Trading is not affected\.$/);
    assert.equal(posts, 2);
    assert.match((await reporter.maybeSend(t0 + 2 * REPORT_INTERVAL_MS, "a", async () => { throw new Error("venue down"); })) ?? "", /not sent/);
    assert.equal(await reporter.maybeSend(t0 + 3 * REPORT_INTERVAL_MS, "a", async () => null), null);
    assert.equal(posts, 2);

    const off = new Reporter(gateway, "theme", "beta", false);
    assert.equal(await off.maybeSend(t0, "a", async () => figures), null);
    assert.equal(posts, 2);

    // A restart inside the window does not send again.
    const restarted = new Reporter(gateway, "theme", "alpha", true);
    assert.equal(restarted.due(t0 + REPORT_INTERVAL_MS + 1000), false);
  });

  it("sends one early report after an acknowledged order, and never closer than 30 seconds to the last", async () => {
    const bodies: Report[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Report);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const reporter = new Reporter({ gatewayUrl: "https://gw.example", apiKey: API_KEY, fetchImpl }, "theme", "gamma", true);
    const full = async () => ({ ...figures, positions: [position()], trades: [trade(0)] });
    await reporter.maybeSend(T0, "a", full);
    assert.equal(bodies.length, 1);

    reporter.requestPrompt();
    assert.equal(reporter.due(T0 + 10_000), false, "rate limited");
    assert.equal(reporter.due(T0 + PROMPT_REPORT_INTERVAL_MS), true);
    await reporter.maybeSend(T0 + PROMPT_REPORT_INTERVAL_MS, "Bought.", full);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1]!.trades!.length, 1);
    // One order, one early report: the next waits out the five minutes again.
    assert.equal(reporter.due(T0 + 2 * PROMPT_REPORT_INTERVAL_MS), false);
    assert.equal(reporter.due(T0 + PROMPT_REPORT_INTERVAL_MS + REPORT_INTERVAL_MS), true);

    const off = new Reporter({ gatewayUrl: "https://gw.example", apiKey: API_KEY, fetchImpl }, "theme", "delta", false);
    off.requestPrompt();
    assert.equal(off.due(T0 + REPORT_INTERVAL_MS), false);
  });

  it("drops a malformed report with one line and sends the totals alone, and does the same for a gateway that refuses the newer fields", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let refuseExtras = false;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      return new Response("{}", { status: refuseExtras && "positions" in body ? 400 : 200 });
    }) as unknown as typeof fetch;
    const reporter = new Reporter({ gatewayUrl: "https://gw.example", apiKey: API_KEY, fetchImpl }, "theme", "epsilon", true);
    const line = await reporter.maybeSend(T0, "a", async () => ({ ...figures, positions: [position({ side: "<script>" })] }));
    assert.match(line ?? "", /left out .* The totals were sent\. Trading is not affected\.$/);
    assert.equal(bodies.length, 1, "the malformed report itself never left");
    assert.deepEqual(Object.keys(bodies[0]!).sort(), Object.keys(totalsOnly(buildReport(figures, "a", T0))).sort());

    refuseExtras = true;
    const first = await reporter.maybeSend(T0 + REPORT_INTERVAL_MS, "a", async () => ({ ...figures, positions: [position()] }));
    assert.match(first ?? "", /gateway answered 400/);
    assert.equal(bodies.length, 3);
    assert.equal("positions" in bodies[2]!, false);
    // Said once, not every five minutes.
    assert.equal(await reporter.maybeSend(T0 + 2 * REPORT_INTERVAL_MS, "a", async () => ({ ...figures, positions: [position()] })), null);
  });
});

describe("discoverConfig", () => {
  const stock = { strategyId: "stock-ls", version: 1, updatedAt: "2026-09-19T00:00:00.000Z", config: { v: 1, strategyId: "stock-ls", strategy: { assetKey: "NVDA" }, account } };
  const theme = { strategyId: "theme", version: 1, updatedAt: "2026-09-19T00:00:00.000Z", config: { v: 1, strategyId: "theme", strategy: { thesis: "AI capex", markets: [{ conditionId: "0xabc", tokenIds: ["1", "2"], outcomes: ["Yes", "No"], side: 0, question: "Q?", marketKey: null }] }, account } };

  it("falls through to the theme config when the key is not a single-asset key", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return url.includes("/stock-ls/") ? new Response("{}", { status: 403 }) : new Response(JSON.stringify(theme), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await discoverConfig({ gatewayUrl: "https://gw.example", apiKey: API_KEY, fetchImpl });
    assert.equal(result.ok && result.value.strategyId, "theme");
    assert.deepEqual(urls, ["https://gw.example/api/v1/strategies/stock-ls/config", "https://gw.example/api/v1/strategies/theme/config"]);
  });

  it("stops at the single-asset config when it is served, and does not try theme on a 401", async () => {
    let calls = 0;
    const ok = (async () => { calls += 1; return new Response(JSON.stringify(stock), { status: 200 }); }) as unknown as typeof fetch;
    assert.equal((await discoverConfig({ gatewayUrl: "https://gw.example", apiKey: API_KEY, fetchImpl: ok })).ok, true);
    assert.equal(calls, 1);
    calls = 0;
    const unauthorized = (async () => { calls += 1; return new Response("{}", { status: 401 }); }) as unknown as typeof fetch;
    assert.equal((await discoverConfig({ gatewayUrl: "https://gw.example", apiKey: API_KEY, fetchImpl: unauthorized })).ok, false);
    assert.equal(calls, 1);
  });
});
