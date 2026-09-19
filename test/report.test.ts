import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { discoverConfig, postReport } from "../src/client.js";
import { ReportSchema } from "../src/protocol/index.js";
import { REPORT_INTERVAL_MS, Reporter, buildReport, sanitizeAction } from "../src/report.js";
import { loadRuntimeState } from "../src/runtime-state.js";

const API_KEY = `qsk_${"test".repeat(3)}`;
const figures = { venue: "polymarket" as const, equityUsd: 1234.567, netDepositsUsd: 1000, volumeUsd: 4321.009, openPositions: 3 };
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
    assert.deepEqual(await postReport({ gatewayUrl: "https://gw.example", apiKey: API_KEY, fetchImpl: down }, "stock-ls", buildReport(figures, "x", 0)), { ok: false, message: "the gateway answered 500" });
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
