import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs, UsageError } from "../src/args.js";
import { fetchConfig, fetchTarget, normalizeGatewayUrl } from "../src/client.js";
import { forcedTarget } from "../src/commands/run.js";
import { parseTarget, type TargetDoc } from "../src/protocol/index.js";
import { scrub } from "../src/session.js";

const KEY = "qsk_test_0123456789abcdef";
const validConfig = {
  strategyId: "stock-ls", version: 1, updatedAt: "2026-09-19T01:55:34.853Z",
  config: { v: 1, strategyId: "stock-ls", strategy: { assetKey: "crypto:btc" }, account: { positionPct: 5, token: { chainId: 8453, address: "0xabc" }, split: { buybackPct: 70, keepPct: 30 } } },
};
const validTarget: TargetDoc = {
  v: 1, strategyId: "stock-ls", asOf: "2026-09-19T02:47:11.271Z", validUntil: "2026-09-19T02:52:11.271Z", mode: "open",
  target: { assetKey: "crypto:btc", coin: "BTC", dex: "", side: "flat", flatReason: "neutral", entryLimit: null, targetPx: null, stopPx: null, expiresAt: null, signalId: null, revision: null, reason: "Neutral." },
};

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function stub(responses: Array<Response | Error>): { fetchImpl: typeof fetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error("no more stubbed responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const opts = (fetchImpl: typeof fetch) => ({ gatewayUrl: "https://gateway.example", apiKey: KEY, fetchImpl });

describe("gateway client", () => {
  it("sends the key in the header, to the right path, and returns the parsed config", async () => {
    const { fetchImpl, calls } = stub([json(200, validConfig)]);
    const result = await fetchConfig(opts(fetchImpl));
    assert.ok(result.ok);
    assert.equal(calls[0]!.url, "https://gateway.example/api/v1/strategies/stock-ls/config");
    assert.equal(calls[0]!.headers["x-quotient-api-key"], KEY);
    assert.ok(!calls[0]!.url.includes(KEY));
  });

  it("maps 401 and 403 to auth", async () => {
    for (const status of [401, 403]) {
      const result = await fetchTarget(opts(stub([json(status, { error: "invalid_strategy_key" })]).fetchImpl));
      assert.ok(!result.ok && result.kind === "auth");
    }
  });

  it("maps 404 not_configured", async () => {
    const result = await fetchConfig(opts(stub([json(404, { error: "not_configured", message: "x" })]).fetchImpl));
    assert.ok(!result.ok && result.kind === "not_configured");
  });

  it("maps 503 and other statuses to unavailable, without retrying", async () => {
    const { fetchImpl, calls } = stub([json(503, { error: "target_unavailable" })]);
    const result = await fetchTarget(opts(fetchImpl));
    assert.ok(!result.ok && result.kind === "unavailable");
    assert.match(!result.ok ? result.message : "", /503 \(target_unavailable\)/);
    assert.equal(calls.length, 1);
  });

  it("maps a schema mismatch and a non-JSON body to invalid", async () => {
    const mismatch = await fetchTarget(opts(stub([json(200, { ...validTarget, mode: "pause" })]).fetchImpl));
    assert.ok(!mismatch.ok && mismatch.kind === "invalid");
    const html = await fetchTarget(opts(stub([new Response("<html>", { status: 200 })]).fetchImpl));
    assert.ok(!html.ok && html.kind === "invalid");
  });

  it("retries once on a network error, then succeeds", async () => {
    const { fetchImpl, calls } = stub([new TypeError("fetch failed"), json(200, validTarget)]);
    assert.ok((await fetchTarget(opts(fetchImpl))).ok);
    assert.equal(calls.length, 2);
  });

  it("never throws: two network errors come back as unavailable", async () => {
    const { fetchImpl, calls } = stub([new TypeError("fetch failed"), new TypeError("fetch failed")]);
    const result = await fetchTarget(opts(fetchImpl));
    assert.ok(!result.ok && result.kind === "unavailable");
    assert.equal(calls.length, 2);
  });

  it("never puts the key or a server-supplied message in a failure message", async () => {
    const result = await fetchTarget(opts(stub([json(500, { error: "boom", message: `echo ${KEY}` })]).fetchImpl));
    assert.ok(!result.ok && !result.message.includes(KEY));
  });

  it("requires https unless the gateway is on this machine", () => {
    assert.equal(normalizeGatewayUrl("https://quotient-api-gateway.onrender.com/"), "https://quotient-api-gateway.onrender.com");
    assert.equal(normalizeGatewayUrl("http://localhost:3000"), "http://localhost:3000");
    assert.throws(() => normalizeGatewayUrl("http://example.com"), /https/);
    assert.throws(() => normalizeGatewayUrl("https://user:pass@example.com"), /credentials/);
    assert.throws(() => normalizeGatewayUrl("not a url"));
  });
});

describe("forced target", () => {
  it("builds a long from the mid: target 2% up, stop 1.5% down, entry limit halfway, one hour", () => {
    const now = Date.parse("2026-09-18T12:00:00Z");
    const forced = forcedTarget(validTarget, "long", 100_000, now);
    assert.equal(forced.target.targetPx, 102_000);
    assert.equal(forced.target.stopPx, 98_500);
    assert.equal(forced.target.entryLimit, 101_000);
    assert.equal(forced.target.expiresAt, "2026-09-18T13:00:00.000Z");
    assert.equal(forced.target.coin, "BTC");
    assert.ok(parseTarget({ ...forced, validUntil: new Date(now + 60_000).toISOString() }).ok);
  });

  it("mirrors the levels for a short and builds a neutral flat", () => {
    const short = forcedTarget(validTarget, "short", 100_000, 0);
    assert.deepEqual([short.target.targetPx, short.target.stopPx, short.target.entryLimit], [98_000, 101_500, 99_000]);
    assert.ok(parseTarget(short).ok);
    const flat = forcedTarget(validTarget, "flat", 100_000, 0);
    assert.equal(flat.target.flatReason, "neutral");
    assert.ok(parseTarget(flat).ok);
  });
});

describe("argv", () => {
  it("parses a command, values, flags and positionals", () => {
    const args = parseArgs(["run", "--dry-run", "--interval", "10", "--force-side=long", "--id", "alpha"]);
    assert.equal(args.command, "run");
    assert.ok(args.flags.has("dry-run"));
    assert.deepEqual({ ...args.values }, { interval: "10", "force-side": "long", id: "alpha" });
    assert.deepEqual(parseArgs(["config", "accept"]).positionals, ["accept"]);
  });

  it("rejects unknown options and missing values", () => {
    assert.throws(() => parseArgs(["run", "--dryrun"]), UsageError);
    assert.throws(() => parseArgs(["init", "--key"]), UsageError);
    assert.throws(() => parseArgs(["init", "--key", "--force"]), UsageError);
    assert.throws(() => parseArgs(["run", "--once=yes"]), UsageError);
  });
});

describe("scrub", () => {
  it("removes secrets from a line", () => {
    assert.equal(scrub(`failed with ${KEY} in it`, [KEY, undefined]), "failed with [redacted] in it");
  });
});
