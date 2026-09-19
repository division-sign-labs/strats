import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runtimeStateFile } from "../src/paths.js";
import type { ReportTrade } from "../src/protocol/index.js";
import { toReportTrade } from "../src/report.js";
import { appendTrade, emptyRuntimeState, loadRuntimeState, saveRuntimeState } from "../src/runtime-state.js";

const T0 = Date.parse("2026-09-19T12:00:00.000Z");
const trade = (n: number): ReportTrade => toReportTrade({ at: T0 + n * 60_000, label: `Will thing ${n} happen?`, action: n % 2 === 0 ? "buy" : "sell", sizeUsd: 10 + n, price: 0.5 })!;

describe("the trade ring", () => {
  let home: string;
  const savedHome = process.env.STRATS_HOME;
  before(() => {
    home = mkdtempSync(join(tmpdir(), "strats-ring-"));
    process.env.STRATS_HOME = home;
  });
  after(() => {
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.STRATS_HOME; else process.env.STRATS_HOME = savedHome;
  });

  it("starts empty, and an older state file without the field reads as empty", () => {
    assert.deepEqual(emptyRuntimeState().trades, []);
    saveRuntimeState("older", emptyRuntimeState());
    const path = runtimeStateFile("older");
    const { trades: _trades, ...withoutTrades } = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...withoutTrades, volumeUsd: 12, entered: { "0xabc:0": "2026-09-18T00:00:00.000Z" } }));
    const state = loadRuntimeState("older");
    assert.deepEqual(state.trades, []);
    assert.equal(state.volumeUsd, 12);
  });

  it("keeps the newest 30, newest first, and does not change the list it was given", () => {
    let trades: ReportTrade[] = [];
    for (let n = 0; n < 45; n++) {
      const previous = trades;
      trades = appendTrade(trades, trade(n));
      assert.notEqual(trades, previous);
    }
    assert.equal(trades.length, 30);
    assert.equal(trades[0]!.label, "Will thing 44 happen?");
    assert.equal(trades[29]!.label, "Will thing 15 happen?");
    assert.ok(trades.every((t, i, all) => i === 0 || Date.parse(all[i - 1]!.at) > Date.parse(t.at)));
  });

  it("survives a reload, next to the counters that were already there", () => {
    let state = { ...loadRuntimeState("ring"), volumeUsd: 321, entered: { "0xabc:0": "2026-09-18T00:00:00.000Z" } };
    for (let n = 0; n < 35; n++) state = { ...state, trades: appendTrade(state.trades, trade(n)) };
    saveRuntimeState("ring", state);

    const reloaded = loadRuntimeState("ring");
    assert.equal(reloaded.trades.length, 30);
    assert.deepEqual(reloaded.trades[0], trade(34));
    assert.deepEqual(reloaded.trades, state.trades);
    assert.equal(reloaded.volumeUsd, 321);
    assert.deepEqual(reloaded.entered, { "0xabc:0": "2026-09-18T00:00:00.000Z" });

    // One more after the restart still lands in front, and the ring stays at 30.
    saveRuntimeState("ring", { ...reloaded, trades: appendTrade(reloaded.trades, trade(99)) });
    const again = loadRuntimeState("ring");
    assert.equal(again.trades.length, 30);
    assert.equal(again.trades[0]!.label, "Will thing 99 happen?");
  });

  it("never writes more than 30, and a damaged list costs the list only, not the markets already entered", () => {
    saveRuntimeState("long", { ...emptyRuntimeState(), trades: Array.from({ length: 50 }, (_, n) => trade(n)) });
    assert.equal(loadRuntimeState("long").trades.length, 30);

    const path = runtimeStateFile("long");
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...raw, entered: { "0xabc:0": "2026-09-18T00:00:00.000Z" }, trades: [{ at: "not a time", label: "", action: "buy" }] }));
    const state = loadRuntimeState("long");
    assert.deepEqual(state.trades, []);
    assert.deepEqual(state.entered, { "0xabc:0": "2026-09-18T00:00:00.000Z" }, "a market is still entered once");
  });

  it("holds nothing secret and no address", () => {
    const address = `0x${"ab".repeat(20)}`;
    const stored = toReportTrade({ at: T0, label: `Sold for ${address}`, action: "sell", sizeUsd: 5 })!;
    saveRuntimeState("plain", { ...emptyRuntimeState(), trades: [stored] });
    assert.ok(!readFileSync(runtimeStateFile("plain"), "utf8").includes(address));
  });
});
