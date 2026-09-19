import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROTOCOL_VERSION, dexOfCoin, parseConfig, parseTarget } from "../src/protocol/index.js";

const config = (): Record<string, any> => ({
  strategyId: "stock-ls", version: 3, updatedAt: "2026-09-19T01:55:34.853Z",
  config: {
    v: 1, strategyId: "stock-ls", strategy: { assetKey: "crypto:btc" },
    account: { positionPct: 5, token: { chainId: 8453, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, split: { buybackPct: 70, keepPct: 30 } },
  },
});

const flatTarget = (): Record<string, any> => ({
  v: 1, strategyId: "stock-ls", asOf: "2026-09-19T02:47:11.271Z", validUntil: "2026-09-19T02:52:11.271Z", mode: "open",
  target: {
    assetKey: "crypto:btc", coin: "BTC", dex: "", side: "flat", flatReason: "neutral", entryLimit: null, targetPx: null, stopPx: null,
    expiresAt: null, signalId: null, revision: null, reason: "Q has no directional signal on this asset's nearest horizon.",
  },
});

const longTarget = (): Record<string, any> => {
  const doc = flatTarget();
  Object.assign(doc.target, { coin: "xyz:NVDA", dex: "xyz", assetKey: "stock:nvda", side: "long", flatReason: null, entryLimit: 181, targetPx: 184, stopPx: 176, expiresAt: "2026-09-20T00:00:00Z", signalId: "sig-9", revision: 2 });
  return doc;
};

describe("protocol", () => {
  it("exposes the protocol version", () => assert.equal(PROTOCOL_VERSION, 1));

  it("parses a valid config", () => {
    const parsed = parseConfig(config());
    assert.ok(parsed.ok);
    assert.equal(parsed.value.config.account.positionPct, 5);
    assert.equal(parsed.value.config.account.token.chainId, 8453);
  });

  it("parses a valid flat target and a valid long target", () => {
    assert.ok(parseTarget(flatTarget()).ok);
    const parsed = parseTarget(longTarget());
    assert.ok(parsed.ok);
    assert.equal(parsed.value.target.coin, "xyz:NVDA");
  });

  it("tolerates unknown extra fields at every level", () => {
    const c = config();
    c.newTopLevel = { anything: true };
    c.config.account.futureField = 1;
    c.config.account.token.symbol = "USDC";
    assert.ok(parseConfig(c).ok);
    const t = longTarget();
    t.serverHint = "x";
    t.target.confidence = 0.7;
    assert.ok(parseTarget(t).ok);
  });

  it("rejects a config with a missing required field", () => {
    for (const path of [["config", "account", "positionPct"], ["config", "account", "token"], ["config", "account", "split", "keepPct"], ["version"], ["config", "strategy", "assetKey"]]) {
      const c = config();
      let cursor = c;
      for (const key of path.slice(0, -1)) cursor = cursor[key!];
      delete cursor[path.at(-1)!];
      const parsed = parseConfig(c);
      assert.equal(parsed.ok, false, path.join("."));
      if (!parsed.ok) assert.ok(parsed.reason.length > 0);
    }
  });

  it("rejects a position size outside 1 to 50", () => {
    for (const positionPct of [0, 0.5, 51, 100, "5", null]) {
      const c = config();
      c.config.account.positionPct = positionPct;
      assert.equal(parseConfig(c).ok, false, String(positionPct));
    }
  });

  it("rejects a target with a missing required field", () => {
    for (const key of ["validUntil", "mode", "target"]) {
      const t = flatTarget();
      delete t[key];
      assert.equal(parseTarget(t).ok, false, key);
    }
    for (const key of ["coin", "dex", "side", "flatReason", "stopPx", "reason"]) {
      const t = longTarget();
      delete t.target[key];
      assert.equal(parseTarget(t).ok, false, key);
    }
  });

  it("rejects values it does not know, so the runner holds", () => {
    const cases: Array<[string, (t: Record<string, any>) => void]> = [
      ["unknown side", (t) => (t.target.side = "hedge")],
      ["unknown mode", (t) => (t.mode = "pause")],
      ["unknown flat reason", (t) => Object.assign(t.target, { side: "flat", flatReason: "maintenance" })],
      ["other protocol version", (t) => (t.v = 2)],
      ["other strategy", (t) => (t.strategyId = "other")],
      ["bad time", (t) => (t.validUntil = "soon")],
      ["negative price", (t) => (t.target.stopPx = -1)],
    ];
    for (const [name, mutate] of cases) {
      const t = longTarget();
      mutate(t);
      assert.equal(parseTarget(t).ok, false, name);
    }
  });

  it("rejects a directional target without its price levels", () => {
    for (const key of ["entryLimit", "targetPx", "stopPx"]) {
      const t = longTarget();
      t.target[key] = null;
      assert.equal(parseTarget(t).ok, false, key);
    }
  });

  it("accepts a directional target whose signal has no expiry, id or revision", () => {
    const t = longTarget();
    Object.assign(t.target, { expiresAt: null, signalId: null, revision: null });
    assert.ok(parseTarget(t).ok);
  });

  it("rejects levels that are out of order for the side", () => {
    const t = longTarget();
    t.target.stopPx = 190;
    assert.equal(parseTarget(t).ok, false);
    const s = longTarget();
    Object.assign(s.target, { side: "short" });
    assert.equal(parseTarget(s).ok, false, "long-ordered levels on a short");
  });

  it("rejects a flat target without a reason code", () => {
    const t = flatTarget();
    t.target.flatReason = null;
    assert.equal(parseTarget(t).ok, false);
  });

  it("rejects a coin that does not belong to the stated dex", () => {
    const t = longTarget();
    t.target.dex = "";
    assert.equal(parseTarget(t).ok, false);
    const b = flatTarget();
    b.target.dex = "xyz";
    assert.equal(parseTarget(b).ok, false);
  });

  it("derives the dex from the coin", () => {
    assert.equal(dexOfCoin("BTC"), "");
    assert.equal(dexOfCoin("xyz:NVDA"), "xyz");
    assert.equal(dexOfCoin("a:b:c"), null);
    assert.equal(dexOfCoin(" BTC"), null);
    assert.equal(dexOfCoin(":NVDA"), null);
  });

  it("rejects non-objects", () => {
    for (const value of [null, undefined, "x", 1, []]) {
      assert.equal(parseConfig(value).ok, false);
      assert.equal(parseTarget(value).ok, false);
    }
  });
});
