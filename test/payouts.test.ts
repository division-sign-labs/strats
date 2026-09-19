import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ensurePrivateDir, payoutsLedgerFile, payoutsSummaryFile, stateDir } from "../src/paths.js";
import { appendLedger, parseLedger, payoutRows, pushPayoutSummary, readLedger, readPayoutSummary, summarize, summary, type BuybackLine, type WithdrawalLine } from "../src/payouts.js";
import type { Report } from "../src/protocol/index.js";
import { Reporter, buildReport, withPayouts } from "../src/report.js";
import { saveRuntimeState, emptyRuntimeState } from "../src/runtime-state.js";

const TOKEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const DEST = `0x${"d2".repeat(20)}`;
const withdrawal = (id: string, at: string, usd = 197.47, profitSettledUsd = 282.1): WithdrawalLine => ({ v: 1, type: "withdrawal", id, at, venue: "hyperliquid", usd, feeUsd: 1, profitSettledUsd, buybackPct: 70 });
const bought = (id: string, at: string, spentUsd = 196.47): BuybackLine => ({ v: 1, type: "buyback", id, at, spentUsd, fromChainId: 42161, token: { chainId: 8453, address: TOKEN }, destination: DEST, received: "1204551000000000000000000", decimals: 18, txHash: `0x${"c8".repeat(32)}`, tool: "relay" });

describe("the payout record", () => {
  let home: string;
  const savedHome = process.env.STRATS_HOME;
  before(() => {
    home = mkdtempSync(join(tmpdir(), "strats-payouts-"));
    process.env.STRATS_HOME = home;
  });
  after(() => {
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.STRATS_HOME; else process.env.STRATS_HOME = savedHome;
  });

  it("is empty when there is no file", () => {
    assert.deepEqual(readLedger("none"), { lines: [], skipped: 0 });
    assert.deepEqual(summary("none"), { boughtBackUsd: 0, withdrawals: [], settledUsd: 0 });
    assert.deepEqual(readPayoutSummary("none"), { v: 1, boughtBackUsd: 0, withdrawals: [] });
  });

  it("appends one line per event to a private file, and adds up what was settled and what was bought", () => {
    assert.equal(appendLedger("alpha", withdrawal("p1", "2026-09-10T00:00:00.000Z")), true);
    assert.equal(appendLedger("alpha", bought("p1", "2026-09-10T00:10:00.000Z")), true);
    assert.equal(appendLedger("alpha", withdrawal("p2", "2026-09-19T00:00:00.000Z", 50, 71.43)), true);
    const text = readFileSync(payoutsLedgerFile("alpha"), "utf8");
    assert.equal(text.trimEnd().split("\n").length, 3);
    assert.equal(text.endsWith("\n"), true);
    assert.equal(statSync(payoutsLedgerFile("alpha")).mode & 0o777, 0o600);
    assert.deepEqual(summary("alpha"), {
      boughtBackUsd: 196.47, settledUsd: 353.53,
      withdrawals: [{ at: "2026-09-10T00:00:00.000Z", usd: 197.47 }, { at: "2026-09-19T00:00:00.000Z", usd: 50 }],
    });
  });

  it("refuses a second line of the same kind for the same payout, so repeating a step never counts twice", () => {
    assert.equal(appendLedger("alpha", withdrawal("p1", "2026-09-11T00:00:00.000Z", 999, 999)), false);
    assert.equal(appendLedger("alpha", bought("p1", "2026-09-11T00:00:00.000Z", 999)), false);
    assert.equal(summary("alpha").settledUsd, 353.53);
    assert.equal(readLedger("alpha").lines.length, 3);
  });

  it("counts a withdrawal as settled even when no purchase followed", () => {
    const totals = summary("alpha");
    assert.equal(totals.withdrawals.length, 2);
    assert.equal(totals.boughtBackUsd, 196.47);
  });

  it("refuses a line that does not match the format", () => {
    assert.throws(() => appendLedger("alpha", { ...bought("p9", "2026-09-19T00:00:00.000Z"), received: "1.5" }));
    assert.throws(() => appendLedger("alpha", { ...withdrawal("p9", "not a time") }));
  });

  it("skips a damaged line, counts it, never rewrites it, and starts the next line cleanly after a line cut short", () => {
    ensurePrivateDir(stateDir());
    const path = payoutsLedgerFile("beta");
    writeFileSync(path, `${JSON.stringify(withdrawal("p1", "2026-09-10T00:00:00.000Z"))}\nnot json\n{"v":1,"type":"withdrawal","id":"cut`);
    assert.equal(readLedger("beta").skipped, 2);
    assert.equal(readLedger("beta").lines.length, 1);
    assert.equal(appendLedger("beta", withdrawal("p2", "2026-09-12T00:00:00.000Z", 10, 14.29)), true);
    const text = readFileSync(path, "utf8");
    assert.ok(text.includes("not json\n") && text.includes('"id":"cut\n'), "the damaged lines are still there, untouched");
    assert.deepEqual(readLedger("beta").lines.map((l) => l.id), ["p1", "p2"]);
    assert.equal(parseLedger("\n\n").skipped, 0);
  });

  it("rewrites the totals file after every append: two numbers and dated amounts, nothing else", () => {
    const file = JSON.parse(readFileSync(payoutsSummaryFile("alpha"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(file).sort(), ["boughtBackUsd", "v", "withdrawals"]);
    assert.deepEqual(file, { v: 1, boughtBackUsd: 196.47, withdrawals: [{ at: "2026-09-19T00:00:00.000Z", usd: 50 }, { at: "2026-09-10T00:00:00.000Z", usd: 197.47 }] });
    assert.ok(!JSON.stringify(file).includes("0x"), "no address and no transaction hash");
  });

  it("reads a damaged totals file as zeros", () => {
    ensurePrivateDir(stateDir());
    writeFileSync(payoutsSummaryFile("gamma"), "{ damaged");
    assert.deepEqual(readPayoutSummary("gamma"), { v: 1, boughtBackUsd: 0, withdrawals: [] });
    writeFileSync(payoutsSummaryFile("gamma"), JSON.stringify({ v: 1, boughtBackUsd: -5, withdrawals: [] }));
    assert.deepEqual(readPayoutSummary("gamma"), { v: 1, boughtBackUsd: 0, withdrawals: [] });
  });

  it("gives strats status two rows", () => {
    assert.deepEqual(payoutRows("alpha"), ["  Bought back      $196.47 in 1 buyback", "  Last buyback     $196.47 on 2026-09-10"]);
    assert.deepEqual(payoutRows("none"), ["  Bought back      nothing yet. To see what a buyback would do: strats buyback", "  Last buyback     none"]);
  });

  it("has no droplet to tell when the bot is not deployed, and does not try", () => {
    assert.deepEqual(pushPayoutSummary({ id: "alpha" }), { pushed: false, reason: "not-deployed" });
  });

  it("keeps the newest 500 withdrawals in the totals file", () => {
    const lines = Array.from({ length: 510 }, (_, i) => withdrawal(`p${i}`, new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 3_600_000).toISOString(), 10, 14.29));
    ensurePrivateDir(stateDir());
    writeFileSync(payoutsLedgerFile("many"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    appendFileSync(payoutsLedgerFile("many"), "");
    assert.equal(appendLedger("many", bought("p0", "2026-02-01T00:00:00.000Z")), true);
    const file = readPayoutSummary("many");
    assert.equal(file.withdrawals.length, 500);
    assert.equal(file.withdrawals[0]!.at, lines.at(-1)!.at);
    assert.equal(summarize(readLedger("many").lines).withdrawals.length, 510);
  });
});

describe("the report after a buyback", () => {
  let home: string;
  const savedHome = process.env.STRATS_HOME;
  const API_KEY = `qsk_${"test".repeat(3)}`;
  before(() => {
    home = mkdtempSync(join(tmpdir(), "strats-payouts-report-"));
    process.env.STRATS_HOME = home;
  });
  after(() => {
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.STRATS_HOME; else process.env.STRATS_HOME = savedHome;
  });
  const figures = (venue: "hyperliquid" | "polymarket") => ({ venue, equityUsd: 1284.63, netDepositsUsd: 1000, volumeUsd: 100, openPositions: 0 });

  it("carries what was bought back, and no longer a fixed zero", () => {
    assert.equal(buildReport({ ...figures("hyperliquid"), boughtBackUsd: 196.474 }, "x", 0).boughtBackUsd, 196.47);
    assert.equal(buildReport(figures("hyperliquid"), "x", 0).boughtBackUsd, 0);
    assert.equal(buildReport({ ...figures("hyperliquid"), boughtBackUsd: -3 }, "x", 0).boughtBackUsd, 0);
  });

  it("on Hyperliquid adds the total and leaves net deposits alone, because the venue's own history already dropped", () => {
    appendLedger("hl", withdrawal("p1", "2026-09-10T00:00:00.000Z"));
    appendLedger("hl", bought("p1", "2026-09-10T00:10:00.000Z"));
    const out = withPayouts({ ...figures("hyperliquid"), netDepositsUsd: 802.53 }, "hl");
    assert.equal(out.boughtBackUsd, 196.47);
    assert.equal(out.netDepositsUsd, 802.53);
  });

  it("on Polymarket takes each withdrawal made after the deposits figure was recorded off that figure, so profit does not drop", () => {
    saveRuntimeState("pm", { ...emptyRuntimeState(), netDepositsUsd: 1000, netDepositsAt: "2026-09-01T00:00:00.000Z" });
    appendLedger("pm", { ...withdrawal("p0", "2026-08-01T00:00:00.000Z", 40, 57.14), venue: "polymarket", feeUsd: 0 });
    appendLedger("pm", { ...withdrawal("p1", "2026-09-10T00:00:00.000Z"), venue: "polymarket", feeUsd: 0 });
    const out = withPayouts(figures("polymarket"), "pm");
    assert.equal(out.netDepositsUsd, 802.53);
    assert.equal(out.boughtBackUsd, 0, "a withdrawal is not a purchase until the swap finishes");
    const report = buildReport(out, "x", 0);
    assert.equal(report.profitUsd, 482.1);
  });

  it("reads a missing or damaged totals file as nothing bought back, and still sends the report", async () => {
    ensurePrivateDir(stateDir());
    writeFileSync(payoutsSummaryFile("broken"), "{{{");
    assert.deepEqual(withPayouts(figures("polymarket"), "broken"), { ...figures("polymarket"), boughtBackUsd: 0 });
    assert.deepEqual(withPayouts(figures("hyperliquid"), "absent"), { ...figures("hyperliquid"), boughtBackUsd: 0 });

    const bodies: Report[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Report);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const gateway = { gatewayUrl: "https://gw.example", apiKey: API_KEY, fetchImpl };
    assert.equal(await new Reporter(gateway, "stock-ls", "broken", true).maybeSend(Date.parse("2026-09-19T12:00:00.000Z"), "x", async () => figures("hyperliquid")), null);
    assert.equal(bodies[0]!.boughtBackUsd, 0);
    assert.equal(await new Reporter(gateway, "stock-ls", "hl", true).maybeSend(Date.parse("2026-09-19T12:00:00.000Z"), "x", async () => figures("hyperliquid")), null);
    assert.equal(bodies[1]!.boughtBackUsd, 196.47);
    assert.equal(existsSync(payoutsLedgerFile("broken")), false, "the report never writes the record");
  });
});

describe("the buyback journal file", () => {
  let home: string;
  const savedHome = process.env.STRATS_HOME;
  before(() => {
    home = mkdtempSync(join(tmpdir(), "strats-journal-"));
    process.env.STRATS_HOME = home;
  });
  after(() => {
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.STRATS_HOME; else process.env.STRATS_HOME = savedHome;
  });

  it("can be created once, is private, survives a reload, and refuses to be read when damaged", async () => {
    const { fileJournal } = await import("../src/buyback/journal.js");
    const { buybackJournalFile } = await import("../src/paths.js");
    const store = fileJournal("alpha");
    assert.equal(store.load(), null);
    const journal = {
      v: 1 as const, id: "p1", startedAt: "2026-09-19T14:00:00.000Z", venue: "hyperliquid" as const, dex: "", withdrawUsd: 197.47, arriveUnits: "196470000", feeUsd: 1,
      profitSettledUsd: 282.1, buybackPct: 70, token: { chainId: 8453, address: TOKEN }, tokenSymbol: "TKN", tokenDecimals: 18, destination: DEST,
      floorMinOut: "1", walletBalanceBeforeUnits: "0", stage: "confirmed" as const,
    };
    store.create(journal);
    assert.equal(statSync(buybackJournalFile("alpha")).mode & 0o777, 0o600);
    assert.throws(() => store.create(journal), /already in flight/);
    store.save({ ...journal, stage: "withdraw_sending" });
    assert.equal(fileJournal("alpha").load()?.stage, "withdraw_sending");
    writeFileSync(buybackJournalFile("alpha"), "{ damaged");
    assert.throws(() => store.load(), /cannot be read, so it is not known what was sent/);
    store.remove();
    assert.equal(store.load(), null);
  });
});
