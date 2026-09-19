// The droplet's own buyback, with every outside thing faked: the venue, the
// wallet, LI.FI, the clock, the timers and ssh. Nothing is signed or sent
// anywhere, no droplet is touched, and every key is made up at run time.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { KeyRoles, Keystore, addressFromPk } from "@quotient-forecasting/cassie-core";
import { AUTO_EVERY_MS, AUTO_FIRST_MS, AUTO_SETTINGS, AutoBuybackRefused, assertUnattendedAllowed, runUnattended, scheduleChecks, startAutoBuyback, type AutoPorts, type AutoTimers } from "../src/buyback/auto.js";
import { BasisSchema, buildBasis, loadBasis, mergeBasisLedger, saveBasis, type BuybackBasis } from "../src/buyback/basis.js";
import { lastBuybackLine, pullRecord, pushBasis, type Exec } from "../src/buyback/droplet.js";
import { JournalSchema, fileJournal, type Journal, type Stage } from "../src/buyback/journal.js";
import { QuoteSchema, type Quote, type QuoteRequest, type SwapStatus } from "../src/buyback/lifi.js";
import { MAX_IMPACT_DEFAULT, MIN_USD_DEFAULT, SLIPPAGE_DEFAULT } from "../src/buyback/plan.js";
import { autoBuybackQuestion, describeAutoBuyback } from "../src/buyback/text.js";
import { BuybackRefusal, withdrawalContext, type VenueFigures } from "../src/buyback/venues.js";
import { executeRefusal } from "../src/commands/buyback.js";
import { disclosure, runtimeCredsFor } from "../src/commands/deploy.js";
import { payoutNote } from "../src/commands/status.js";
import { ensureHome, keysDir } from "../src/paths.js";
import { appendLedger, readLedger, readPayoutSummary, type LedgerLine } from "../src/payouts.js";
import { withPayouts } from "../src/report.js";
import { buildRuntimeCreds, decodeRuntimeCreds, encodeRuntimeCreds, type RuntimeCredsDoc } from "../src/runtime-creds.js";
import { saveRuntimeState, emptyRuntimeState } from "../src/runtime-state.js";
import { loadWalletKey, sessionSecrets, type KeystoreSession, type Session } from "../src/session.js";
import { API_KEY_ROLE, BotStateSchema, dropletBuysBack, sendsMasterKey, type BotState } from "../src/state.js";

// Built at run time so no key-shaped literal sits in the repository.
const hexKey = (byte: string): string => `0x${byte.repeat(32)}`;
const MASTER_PK = hexKey("a1");
const AGENT_PK = hexKey("b2");
const SIGNER_PK = hexKey("c3");
const PASSPHRASE = ["correct", "horse", "battery"].join("-");
const API_KEY = `qsk_${"test".repeat(3)}`;
const L2 = { apiKey: "l2-key-id", secret: "l2-secret-value", passphrase: "l2-pass-value" };
const WALLET = addressFromPk(MASTER_PK);
const DEST = `0x${"d2".repeat(20)}`;
const TOKEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const T0 = Date.parse("2026-09-19T14:00:00.000Z");
const DEPLOYMENT = { dropletId: 1, host: "203.0.113.5", region: "blr1", size: "s-1vcpu-1gb", version: "0.5.0", deployedAt: "2026-09-19T00:00:00.000Z" };

const baseBot = (over: Partial<BotState> = {}): BotState => ({
  v: 1, id: "alpha", strategyId: "stock-ls", gatewayUrl: "https://quotient-api-gateway.onrender.com", keyPrefix: API_KEY.slice(0, 12),
  masterAddress: WALLET, agentAddress: addressFromPk(AGENT_PK), ceilingPct: 5, createdAt: "2026-09-18T00:00:00.000Z",
  pinned: { token: { chainId: 8453, address: TOKEN }, split: { buybackPct: 70, keepPct: 30 }, destination: DEST },
  ...over,
});
const themeBot = (over: Partial<BotState> = {}): BotState => {
  const { agentAddress: _agent, ...rest } = baseBot({ id: "theme", strategyId: "theme", polymarket: { signerAddress: WALLET, funder: "0x00000000000000000000000000000000000000f1", signatureType: 3 }, ...over });
  return rest;
};
const hyperliquidArm = { agentPk: AGENT_PK, masterAddress: WALLET };
const polymarketArm = (signerPk = MASTER_PK) => ({ venue: "polymarket" as const, signerPk, funder: "0x00000000000000000000000000000000000000f1", signatureType: 3, l2: L2 });

const runtimeFor = (bot: BotState): RuntimeCredsDoc => buildRuntimeCreds({
  apiKey: API_KEY, gatewayUrl: bot.gatewayUrl, bot, buybackMasterPk: MASTER_PK,
  ...(bot.strategyId === "stock-ls" ? { hyperliquid: hyperliquidArm } : { polymarket: polymarketArm() }),
});
const dropletSession = (bot: BotState): Session => ({ bot, runtime: runtimeFor(bot), gateway: { gatewayUrl: bot.gatewayUrl, apiKey: API_KEY } });

/** A quote that passes every check for `request`, unless a knob says otherwise. */
const quoteFor = (request: QuoteRequest, over: { impactPct?: number; minOut?: bigint; to?: string } = {}): Quote => {
  const usdIn = Number(request.fromAmount) / 1e6;
  const minOut = over.minOut ?? 1_000_000n * 10n ** 18n;
  return QuoteSchema.parse({
    tool: "relay",
    action: {
      fromChainId: request.fromChainId, toChainId: request.toChainId,
      fromToken: { address: request.fromToken, chainId: request.fromChainId, symbol: "USDC", decimals: 6 },
      toToken: { address: request.toToken, chainId: request.toChainId, symbol: "TKN", decimals: 18 },
      fromAmount: request.fromAmount.toString(), fromAddress: request.fromAddress, toAddress: over.to ?? request.toAddress, slippage: request.slippagePct / 100,
    },
    estimate: { approvalAddress: DIAMOND, toAmount: (minOut + 10n ** 18n).toString(), toAmountMin: minOut.toString(), fromAmountUSD: usdIn.toFixed(2), toAmountUSD: (usdIn * (1 - (over.impactPct ?? 1) / 100)).toFixed(2), executionDuration: 11, feeCosts: [], gasCosts: [{ amount: "1000", amountUSD: "0.01", token: { symbol: "ETH" } }] },
    includedSteps: [{ type: "cross", tool: "relay" }],
    transactionRequest: { to: DIAMOND, from: request.fromAddress, chainId: request.fromChainId, data: "0xabcdef", value: "0x0" },
  });
};

interface World {
  ports: AutoPorts;
  events: string[];
  said: string[];
  ledger: LedgerLine[];
  journal: () => Journal | null;
  knobs: {
    figures: VenueFigures | BuybackRefusal;
    basis: BuybackBasis | null;
    quote: (request: QuoteRequest) => Quote | string;
    gasHeld: bigint;
    skipped: number;
    statuses: SwapStatus[];
  };
  requests: QuoteRequest[];
}

function world(start: Journal | null = null): World {
  let now = T0;
  let saved = start;
  let signedCount = 0;
  let withdrawn = start !== null && start.stage !== "confirmed" && start.stage !== "withdraw_sending";
  let arrived = 0n;
  const events: string[] = [];
  const said: string[] = [];
  const ledger: LedgerLine[] = [];
  const requests: QuoteRequest[] = [];
  const receipts = new Map<string, "success" | "reverted">();
  const hashes = new Map<string, string>();
  const wallet = { balance: 5_000_000n, allowance: 0n, mined: 7 };
  const knobs: World["knobs"] = {
    figures: { equityUsd: 1500, basisUsd: 1000, freeUsd: 800 },
    basis: BasisSchema.parse({ v: 1, at: new Date(T0).toISOString(), ledger: [] }),
    quote: (request) => quoteFor(request),
    gasHeld: 10n ** 18n,
    skipped: 0,
    statuses: [{ state: "done", received: (1_000_000n * 10n ** 18n + 5n).toString(), tool: "relay" }],
  };
  const sign = (raw: string): { raw: string; hash: string } => {
    signedCount += 1;
    const signed = { raw: `${raw}:${signedCount}`, hash: `0x${signedCount.toString(16).padStart(64, "0")}` };
    hashes.set(signed.raw, signed.hash);
    return signed;
  };
  const ports: AutoPorts = {
    venue: {
      name: "hyperliquid", label: "Hyperliquid",
      figures: async () => {
        events.push("figures");
        if (knobs.figures instanceof BuybackRefusal) throw knobs.figures;
        return knobs.figures;
      },
      withdraw: async (usdAmount) => {
        events.push(`withdraw:${usdAmount}`);
        withdrawn = true;
        arrived = BigInt(Math.round((usdAmount - 1) * 100)) * 10_000n;
      },
      evidence: async () => "none",
    },
    wallet: {
      address: WALLET, chainId: 42161, chainName: "Arbitrum", sourceSymbol: "USDC", nativeSymbol: "ETH", explorerAddressUrl: `https://arbiscan.io/address/${WALLET}`,
      sourceBalance: async () => wallet.balance + (withdrawn ? (arrived || BigInt(saved?.arriveUnits ?? "0")) : 0n),
      allowance: async () => wallet.allowance,
      minedNonce: async () => wallet.mined,
      nextNonce: async () => wallet.mined,
      nativeBalance: async () => knobs.gasHeld,
      gasPrice: async () => 100_000_000n,
      signApprove: async (amount, nonce) => {
        events.push(`sign-approve:${amount}:${nonce}`);
        return sign(`approve:${amount}`);
      },
      signSwap: async (tx, nonce) => {
        events.push(`sign-swap:${tx.to}:${nonce}`);
        return sign("swap");
      },
      broadcast: async (raw) => {
        events.push(`broadcast:${raw.split(":")[0]}`);
        receipts.set(hashes.get(raw)!, "success");
        wallet.mined += 1;
        if (raw.startsWith("approve")) wallet.allowance = BigInt(raw.split(":")[1]!);
      },
      receipt: async (hash) => receipts.get(hash) ?? null,
    },
    journal: {
      load: () => saved,
      create: (j) => {
        if (saved) throw new Error("A buyback is already in flight.");
        saved = JournalSchema.parse(j);
      },
      save: (j) => {
        saved = JournalSchema.parse(j);
      },
      remove: () => {
        saved = null;
      },
    },
    ledger: {
      read: () => ({ lines: ledger, skipped: knobs.skipped }),
      has: (type, id) => ledger.some((l) => l.type === type && l.id === id),
      append: (line) => {
        ledger.push(line);
        events.push(`ledger:${line.type}`);
      },
    },
    basis: () => knobs.basis,
    fetchQuote: async (request) => {
      requests.push(request);
      events.push(`quote:${request.fromAmount}`);
      const next = knobs.quote(request);
      return typeof next === "string" ? { ok: false, kind: "no-route", message: next } : { ok: true, quote: next };
    },
    fetchStatus: async () => (knobs.statuses.length > 1 ? knobs.statuses.shift()! : knobs.statuses[0]!),
    clock: { now: () => now, sleep: async (ms) => { now += ms; } },
    say: (text) => void said.push(text),
    newId: () => "2026-09-19T14:00:00.000Z-ab12",
    dex: "xyz",
  };
  return { ports, events, said, ledger, journal: () => saved, knobs, requests };
}

const moneyMoved = (w: World): boolean => w.events.some((e) => e.startsWith("withdraw:") || e.startsWith("sign-") || e.startsWith("broadcast:") || e.startsWith("ledger:"));

const journalAt = (stage: Stage, over: Partial<Journal> = {}): Journal => JournalSchema.parse({
  v: 1, id: "2026-09-18T14:00:00.000Z-cd34", startedAt: new Date(T0 - 60 * 60_000).toISOString(), venue: "hyperliquid", dex: "xyz", withdrawUsd: 350, arriveUnits: "349000000", feeUsd: 1,
  profitSettledUsd: 500, buybackPct: 70, token: { chainId: 8453, address: TOKEN }, destination: DEST, tokenSymbol: "TKN", tokenDecimals: 18,
  floorMinOut: "1", walletBalanceBeforeUnits: "5000000", stage, ...over,
});

describe("the unattended buyback refuses", () => {
  it("unless the bot file says autoBuyback, whatever else is true", async () => {
    for (const bot of [baseBot(), baseBot({ autoBuyback: false })]) {
      const w = world();
      // Even a droplet session that somehow carries the key pays nothing when the opt-in is absent.
      const session = { bot, runtime: runtimeFor(baseBot({ autoBuyback: true })) };
      await assert.rejects(() => runUnattended(session, w.ports), (error: Error) => error instanceof AutoBuybackRefused && /Auto-buyback is off/.test(error.message));
      assert.deepEqual(w.events, [], "nothing was read, quoted, signed or sent");
      assert.equal(w.journal(), null);
    }
  });

  it("unless it runs from runtime credentials on the droplet, even with autoBuyback on", async () => {
    const w = world();
    await assert.rejects(() => runUnattended({ bot: baseBot({ autoBuyback: true }) }, w.ports), (error: Error) => error instanceof AutoBuybackRefused && /only on the droplet/.test(error.message));
    assert.deepEqual(w.events, []);
    assert.throws(() => assertUnattendedAllowed({ bot: baseBot({ autoBuyback: true }) }), AutoBuybackRefused);
    assert.doesNotThrow(() => assertUnattendedAllowed(dropletSession(baseBot({ autoBuyback: true }))));
  });

  it("when the opt-in is withdrawn between the plan and the step where the command would have asked a person", async () => {
    const bot = baseBot({ autoBuyback: true });
    const session = { bot, runtime: runtimeFor(bot) };
    const w = world(journalAt("arrived"));
    // A resumed run asks again before it approves or swaps. Here the answer is the opt-in, and it is gone.
    w.knobs.quote = (request) => {
      session.bot = { ...bot, autoBuyback: false };
      return quoteFor(request);
    };
    await assert.rejects(() => runUnattended(session, w.ports), AutoBuybackRefused);
    assert.equal(w.events.some((e) => e.startsWith("sign-") || e.startsWith("broadcast:")), false);
    assert.equal(w.journal()?.stage, "arrived", "the record stays for a later run");
  });

  it("without the payout record strats deploy sends, because what was already split is not known", async () => {
    const w = world();
    w.knobs.basis = null;
    assert.equal(await runUnattended(dropletSession(baseBot({ autoBuyback: true })), w.ports), null);
    assert.deepEqual(w.events, []);
    assert.match(w.said[0]!, /no record of earlier buybacks/);
  });

  it("while strats fund holds it, so a deposit is never measured as profit", async () => {
    const w = world();
    w.knobs.basis = { ...w.knobs.basis!, hold: true };
    assert.equal(await runUnattended(dropletSession(baseBot({ autoBuyback: true })), w.ports), null);
    assert.deepEqual(w.events, []);
    assert.match(w.said[0]!, /^Paused/);
  });

  it("when a line of the payout record cannot be read", async () => {
    const w = world();
    w.knobs.skipped = 1;
    assert.equal(await runUnattended(dropletSession(baseBot({ autoBuyback: true })), w.ports), null);
    assert.equal(moneyMoved(w), false);
    assert.match(w.said[0]!, /could not be read/);
  });
});

describe("the unattended buyback, with the opt-in and on the droplet", () => {
  const session = dropletSession(baseBot({ autoBuyback: true }));

  it("uses the command's defaults and nothing looser: $25, 1% slippage, 3% price impact", () => {
    assert.deepEqual(AUTO_SETTINGS, { minUsd: MIN_USD_DEFAULT, slippagePct: SLIPPAGE_DEFAULT, maxImpactPct: MAX_IMPACT_DEFAULT });
    assert.deepEqual(AUTO_SETTINGS, { minUsd: 25, slippagePct: 1, maxImpactPct: 3 });
  });

  it("pays nothing under the minimum, and says so in one line", async () => {
    const w = world();
    w.knobs.figures = { equityUsd: 1030, basisUsd: 1000, freeUsd: 800 };
    assert.equal(await runUnattended(session, w.ports), null);
    assert.deepEqual(w.events, ["figures"]);
    assert.equal(w.journal(), null);
    assert.deepEqual(w.said, ["Profit to split $30.00. The buyback share is $21.00. Under $25.00 it is not worth the fees. Nothing to do."]);
  });

  it("counts profit that earlier buybacks already split, from the record, so it is not split again", async () => {
    const w = world();
    w.ledger.push({ v: 1, type: "withdrawal", id: "earlier", at: "2026-09-10T00:00:00.000Z", venue: "hyperliquid", usd: 350, feeUsd: 1, profitSettledUsd: 500, buybackPct: 70 });
    assert.equal(await runUnattended(session, w.ports), null);
    assert.equal(moneyMoved(w), false);
    assert.match(w.said[0]!, /^Profit to split \$0\.00\./);
  });

  it("carries out the whole buyback with the same arithmetic as the command: 70% of $500, less Hyperliquid's $1", async () => {
    const w = world();
    assert.deepEqual(await runUnattended(session, w.ports), { code: 0 });
    assert.deepEqual(w.events.filter((e) => e.startsWith("withdraw:")), ["withdraw:350"]);
    assert.deepEqual(w.events.filter((e) => e.startsWith("sign-")), ["sign-approve:349000000:7", `sign-swap:${DIAMOND}:8`]);
    assert.deepEqual(w.ledger.map((l) => l.type), ["withdrawal", "buyback"]);
    const [withdrawal, bought] = w.ledger;
    assert.ok(withdrawal?.type === "withdrawal" && withdrawal.usd === 350 && withdrawal.profitSettledUsd === 500 && withdrawal.buybackPct === 70);
    assert.ok(bought?.type === "buyback" && bought.spentUsd === 349 && bought.destination === DEST && bought.token.address === TOKEN);
    assert.equal(w.journal(), null);
    // The pinned token and destination, the bot's own wallet as the sender, and the default slippage, in every quote request.
    for (const request of w.requests) {
      assert.equal(request.toToken, TOKEN);
      assert.equal(request.toAddress, DEST);
      assert.equal(request.fromAddress, WALLET);
      assert.equal(request.fromToken, USDC);
      assert.equal(request.slippagePct, 1);
      assert.equal(request.fromAmount, 349_000_000n);
    }
    // One plain line for the finished buyback, and no instruction to run a command nobody is there to run.
    assert.equal(w.said.filter((line) => /^Bought /.test(line)).length, 1);
    assert.match(w.said.at(-1)!, /^Bought 1,000,000 TKN for \$349\.00\. They are at 0xd2d2.* on Base\.$/);
    assert.ok(w.said.every((line) => !line.includes("\n") && !/strats buyback --execute/.test(line)));
  });

  it("sends nothing when the quote breaks a cap or a check, exactly as the command refuses it", async () => {
    const cases: Array<[string, (request: QuoteRequest) => Quote | string, RegExp]> = [
      ["price impact over 3%", (r) => quoteFor(r, { impactPct: 3.5 }), /price impact is 3\.5%, above the limit of 3%/],
      ["another destination", (r) => quoteFor(r, { to: `0x${"ee".repeat(20)}` }), /delivers to a different address/],
      ["no route", () => "LI.FI found no route for this swap.", /no route.* Nothing was sent\.$/],
    ];
    for (const [name, quote, expected] of cases) {
      const w = world();
      w.knobs.quote = quote;
      assert.equal(await runUnattended(session, w.ports), null, name);
      assert.equal(moneyMoved(w), false, name);
      assert.equal(w.journal(), null, name);
      assert.match(w.said.at(-1)!, expected, name);
    }
  });

  it("sends nothing when the wallet lacks gas for the swap: money never leaves the venue for a wallet that cannot move it", async () => {
    const w = world();
    w.knobs.gasHeld = 0n;
    assert.equal(await runUnattended(session, w.ports), null);
    assert.equal(moneyMoved(w), false);
    assert.match(w.said.at(-1)!, /^Nothing was sent\. The wallet needs gas/);
  });

  it("says the venue's own refusal and pays nothing", async () => {
    const w = world();
    w.knobs.figures = new BuybackRefusal("The deposit history could not be read in full, so profit cannot be measured. Try again.");
    assert.equal(await runUnattended(session, w.ports), null);
    assert.equal(moneyMoved(w), false);
    assert.match(w.said[0]!, /^Nothing is paid: The deposit history/);
  });

  it("continues a buyback that is part-way first, and never starts a second one beside it", async () => {
    const w = world(journalAt("arrived"));
    assert.deepEqual(await runUnattended(session, w.ports), { code: 0 });
    assert.equal(w.events.includes("figures"), false, "no new plan was made");
    assert.equal(w.events.some((e) => e.startsWith("withdraw:")), false, "the withdrawal is never sent again");
    assert.deepEqual(w.events.filter((e) => e.startsWith("sign-")), ["sign-approve:349000000:7", `sign-swap:${DIAMOND}:8`]);
    assert.match(w.said[0]!, /^Continuing the buyback started /);
    assert.match(w.said.at(-1)!, /^Bought /);
  });

  it("leaves a part-way buyback recorded when the fresh quote breaks a cap, and words the wait for a droplet", async () => {
    const w = world(journalAt("arrived"));
    w.knobs.quote = (r) => quoteFor(r, { impactPct: 9 });
    assert.deepEqual(await runUnattended(session, w.ports), { code: 3 });
    assert.equal(w.journal()?.stage, "arrived");
    assert.equal(w.events.some((e) => e.startsWith("sign-")), false);
    assert.ok(w.said.some((line) => /The droplet continues it at its next check/.test(line)));
  });

  it("plans afresh, from what is pinned now, when the recorded one was confirmed and never sent", async () => {
    const w = world(journalAt("confirmed"));
    assert.deepEqual(await runUnattended(session, w.ports), { code: 0 });
    assert.deepEqual(w.events.filter((e) => e.startsWith("withdraw:")), ["withdraw:350"]);
    assert.equal(w.ledger.filter((l) => l.type === "withdrawal").length, 1);
  });
});

describe("the daily check", () => {
  const fakeTimers = (): AutoTimers & { booked: Array<{ run: () => void; ms: number }>; cleared: number } => {
    const booked: Array<{ run: () => void; ms: number }> = [];
    const timers = { booked, cleared: 0, set: (run: () => void, ms: number) => booked.push({ run, ms }), clear: () => { timers.cleared += 1; } };
    return timers;
  };

  it("is booked 10 minutes after start and then every 24 hours", async () => {
    assert.equal(AUTO_FIRST_MS, 10 * 60_000);
    assert.equal(AUTO_EVERY_MS, 24 * 60 * 60_000);
    const timers = fakeTimers();
    let checks = 0;
    const schedule = scheduleChecks(async () => { checks += 1; }, () => undefined, { timers });
    assert.deepEqual(timers.booked.map((b) => b.ms), [AUTO_FIRST_MS]);
    assert.equal(checks, 0, "nothing runs at start");
    await schedule.tick();
    await schedule.tick();
    assert.equal(checks, 2);
    assert.deepEqual(timers.booked.map((b) => b.ms), [AUTO_FIRST_MS, AUTO_EVERY_MS, AUTO_EVERY_MS]);
  });

  it("catches every error in one line and still books the next check", async () => {
    const timers = fakeTimers();
    const said: string[] = [];
    const schedule = scheduleChecks(async () => { throw new Error("socket\nhang up"); }, (text) => void said.push(text), { timers });
    await assert.doesNotReject(() => schedule.tick());
    assert.deepEqual(said, ["Error. socket hang up Nothing new is tried until the next check."]);
    assert.equal(timers.booked.length, 2);
    // Even a log line that throws never escapes to the trading loops.
    const loud = scheduleChecks(async () => { throw new Error("x"); }, () => { throw new Error("log failed"); }, { timers: fakeTimers() });
    await assert.doesNotReject(() => loud.tick());
  });

  it("never runs two at a time", async () => {
    const timers = fakeTimers();
    const said: string[] = [];
    let release: () => void = () => undefined;
    let running = 0;
    let most = 0;
    const schedule = scheduleChecks(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => { release = resolve; });
      running -= 1;
    }, (text) => void said.push(text), { timers });
    const first = schedule.tick();
    await schedule.tick();
    assert.deepEqual(said, ["The last check is still running, so this one is skipped."]);
    release();
    await first;
    assert.equal(most, 1);
  });

  it("stops when asked", async () => {
    const timers = fakeTimers();
    let checks = 0;
    const schedule = scheduleChecks(async () => { checks += 1; }, () => undefined, { timers });
    schedule.stop();
    await schedule.tick();
    assert.equal(checks, 0);
    assert.equal(timers.cleared, 1);
  });

  it("is not started in a dry run, for --once, with auto-buyback off, or away from a droplet", () => {
    const lines: string[] = [];
    const emit = (text: string): void => void lines.push(text);
    const on = baseBot({ autoBuyback: true });
    assert.equal(startAutoBuyback(dropletSession(on), { dryRun: true, once: false, emit }), undefined);
    assert.equal(startAutoBuyback(dropletSession(on), { dryRun: false, once: true, emit }), undefined);
    assert.equal(startAutoBuyback(dropletSession(baseBot()), { dryRun: false, once: false, emit }), undefined);
    assert.deepEqual(lines, []);
    assert.equal(startAutoBuyback({ bot: on, gateway: { gatewayUrl: on.gatewayUrl, apiKey: API_KEY } }, { dryRun: false, once: false, emit }), undefined);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^buyback {2}Auto-buyback is on, and it runs only on a droplet\. Nothing is paid out by this run\./);
  });
});

describe("what reaches the droplet", () => {
  it("is exactly what it was before when autoBuyback is off, even when the master key is handed to the builder", () => {
    for (const bot of [baseBot(), baseBot({ autoBuyback: false })]) {
      const doc = buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: bot.gatewayUrl, bot, hyperliquid: hyperliquidArm, buybackMasterPk: MASTER_PK });
      const { autoBuyback: _choice, ...settings } = BotStateSchema.parse(bot);
      // Field for field what 0.4.0 sent; the only addition is the choice itself, false, and only when it was made.
      assert.deepEqual(doc, { apiKey: API_KEY, gatewayUrl: bot.gatewayUrl, botState: { ...settings, ...(bot.autoBuyback === false ? { autoBuyback: false } : {}) }, hyperliquid: hyperliquidArm });
      const wire = Buffer.from(encodeRuntimeCreds(doc), "base64url").toString("utf8");
      assert.ok(!wire.includes(MASTER_PK), "master key");
      assert.deepEqual([...wire.matchAll(/0x[0-9a-fA-F]{64}/g)].map((m) => m[0]), [AGENT_PK], "the only 32-byte secret on the wire is the trading key");
      assert.equal(doc.buyback, undefined);
    }
    const theme = themeBot();
    const doc = buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: theme.gatewayUrl, bot: theme, polymarket: polymarketArm(), buybackMasterPk: MASTER_PK });
    assert.deepEqual(Object.keys(doc).sort(), ["apiKey", "botState", "gatewayUrl", "polymarket"]);
  });

  it("adds the master key for a Hyperliquid bot only when autoBuyback is on, and checks it is this wallet's", () => {
    const bot = baseBot({ autoBuyback: true });
    const doc = buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: bot.gatewayUrl, bot, hyperliquid: hyperliquidArm, buybackMasterPk: MASTER_PK });
    assert.deepEqual(Object.keys(doc).sort(), ["apiKey", "botState", "buyback", "gatewayUrl", "hyperliquid"]);
    assert.deepEqual(doc.buyback, { masterPk: MASTER_PK });
    assert.equal(doc.botState.autoBuyback, true);
    assert.deepEqual(decodeRuntimeCreds(encodeRuntimeCreds(doc)), doc);
    assert.throws(() => buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: bot.gatewayUrl, bot, hyperliquid: hyperliquidArm }), /wallet key it needs/);
    assert.throws(() => buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: bot.gatewayUrl, bot, hyperliquid: hyperliquidArm, buybackMasterPk: AGENT_PK }), (error: Error) => /does not match/.test(error.message) && !error.message.includes(AGENT_PK));
  });

  it("adds no key at all for a theme or team bot with autoBuyback on: its wallet key is already there", () => {
    const off = buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: "https://x.example", bot: themeBot(), polymarket: polymarketArm() });
    const on = buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: "https://x.example", bot: themeBot({ autoBuyback: true }), polymarket: polymarketArm(), buybackMasterPk: MASTER_PK });
    assert.deepEqual({ ...on, botState: { ...on.botState, autoBuyback: undefined } }, { ...off, botState: { ...off.botState, autoBuyback: undefined } });
    assert.equal(on.buyback, undefined);
    assert.equal(sendsMasterKey(themeBot({ autoBuyback: true })), false);
    assert.equal(sendsMasterKey(baseBot({ autoBuyback: true })), true);
    assert.equal(sendsMasterKey(baseBot()), false);
  });

  it("drops the deployment record, the droplet's own copy of the setting included", () => {
    const bot = baseBot({ autoBuyback: true, deployment: { ...DEPLOYMENT, autoBuyback: true } });
    const doc = buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: bot.gatewayUrl, bot, hyperliquid: hyperliquidArm, buybackMasterPk: MASTER_PK });
    assert.equal("deployment" in doc.botState, false);
  });

  describe("read from a real keystore by strats deploy", () => {
    let home: string;
    const savedHome = process.env.STRATS_HOME;
    before(() => {
      home = mkdtempSync(join(tmpdir(), "strats-auto-creds-"));
      process.env.STRATS_HOME = home;
      ensureHome();
    });
    after(() => {
      rmSync(home, { recursive: true, force: true });
      if (savedHome === undefined) delete process.env.STRATS_HOME; else process.env.STRATS_HOME = savedHome;
    });
    const sessionFor = (bot: BotState, withMaster: boolean): KeystoreSession => {
      const keystore = new Keystore(keysDir());
      if (withMaster) keystore.putEntry(bot.id, KeyRoles.master, MASTER_PK, PASSPHRASE, { address: WALLET, runtimeEligible: false });
      keystore.putEntry(bot.id, KeyRoles.agent, AGENT_PK, PASSPHRASE, { address: addressFromPk(AGENT_PK), runtimeEligible: true });
      keystore.putEntry(bot.id, API_KEY_ROLE, API_KEY, PASSPHRASE, { runtimeEligible: true });
      return { bot, keystore, passphrase: PASSPHRASE, gateway: { gatewayUrl: bot.gatewayUrl, apiKey: API_KEY } };
    };

    it("with autoBuyback off the master key is never read, so it cannot be sent: a keystore without one deploys the same", () => {
      const withKey = runtimeCredsFor(sessionFor(baseBot({ id: "off-with" }), true));
      const without = runtimeCredsFor(sessionFor(baseBot({ id: "off-without" }), false));
      assert.deepEqual({ ...withKey, botState: { ...withKey.botState, id: "x" } }, { ...without, botState: { ...without.botState, id: "x" } });
      assert.ok(!JSON.stringify(withKey).includes(MASTER_PK));
      assert.deepEqual(Object.keys(withKey).sort(), ["apiKey", "botState", "gatewayUrl", "hyperliquid"]);
    });

    it("with autoBuyback on it reads and sends the master key, and refuses when the keystore has none", () => {
      const doc = runtimeCredsFor(sessionFor(baseBot({ id: "on-with", autoBuyback: true }), true));
      assert.deepEqual(doc.buyback, { masterPk: MASTER_PK });
      assert.throws(() => runtimeCredsFor(sessionFor(baseBot({ id: "on-without", autoBuyback: true }), false)), /no wallet key to send/);
    });
  });

  it("is said in the deploy plan before the y/N: unchanged words when off, one plain sentence when on", () => {
    const off = disclosure(baseBot());
    assert.deepEqual(off, [
      "Sent to the droplet over ssh: the API key; this bot's settings file, which holds addresses, percentages and your choice about publishing the wallet (not published), and nothing secret; the Hyperliquid trading key, which can place orders and cannot withdraw.",
      "The wallet's master key, the keystore file and its passphrase stay on this machine.",
    ]);
    assert.deepEqual(disclosure(baseBot({ autoBuyback: false })), off);
    const on = disclosure(baseBot({ autoBuyback: true }));
    assert.match(on[0]!, /cannot withdraw; the wallet's master key, because auto-buyback is on\.$/);
    assert.match(on[1]!, /^Auto-buyback is on, so the droplet holds the wallet's master key and can withdraw: whoever controls the droplet controls the funds/);
    assert.equal(on.at(-1), "The keystore file and its passphrase stay on this machine.");
    assert.ok(on.every((line) => !/master key.*stay on this machine/.test(line)));

    const themeOff = disclosure(themeBot());
    const themeOn = disclosure(themeBot({ autoBuyback: true }));
    assert.deepEqual(themeOn.slice(0, themeOff.length), themeOff);
    assert.match(themeOn.at(-1)!, /^Auto-buyback is on: once a day the droplet withdraws .* with the wallet key it already holds\. Nothing more is sent for it\.$/);

    const twoVenue = baseBot({ autoBuyback: true, markets: {}, polymarket: { signerAddress: addressFromPk(SIGNER_PK), funder: "0x00000000000000000000000000000000000000f1", signatureType: 3 } });
    const both = disclosure(twoVenue);
    assert.match(both[0]!, /the Polymarket signer key and its API credentials; the wallet's master key, because auto-buyback is on\.$/);
    assert.ok(both.some((line) => /^The droplet holds the Polymarket signer key/.test(line)));
    assert.equal(both.at(-1), "The keystore file and its passphrase stay on this machine.");
  });
});

describe("the wallet key on a droplet", () => {
  it("is not usable for a buyback unless the creator opted in, even where the droplet holds it to trade", () => {
    const theme = themeBot();
    assert.equal(loadWalletKey({ bot: theme, runtime: runtimeFor(theme), gateway: { gatewayUrl: "https://x.example", apiKey: API_KEY } }), null);
    const on = themeBot({ autoBuyback: true });
    assert.equal(loadWalletKey({ bot: on, runtime: runtimeFor(on), gateway: { gatewayUrl: "https://x.example", apiKey: API_KEY } }), MASTER_PK);
    assert.equal(loadWalletKey(dropletSession(baseBot())), null);
    assert.equal(loadWalletKey(dropletSession(baseBot({ autoBuyback: true }))), MASTER_PK);
  });

  it("is scrubbed from every log line", () => {
    assert.ok(sessionSecrets(dropletSession(baseBot({ autoBuyback: true }))).includes(MASTER_PK));
  });

  it("answers a withdrawal's one request and refuses every question, because nobody is there", async () => {
    const ctx = withdrawalContext(dropletSession(baseBot({ autoBuyback: true })), undefined);
    assert.equal(await ctx.getSecret(KeyRoles.master), MASTER_PK);
    assert.equal(await ctx.getSecret(KeyRoles.agent), null);
    await assert.rejects(() => ctx.confirm("Send it?"), /nobody is at the droplet/);
    await assert.rejects(() => ctx.ask("Amount?"), /nobody is at the droplet/);
    await assert.rejects(() => ctx.putSecret("x", "y"), /Nothing is stored/);
    assert.equal(await withdrawalContext(dropletSession(baseBot()), undefined).getSecret(KeyRoles.master), null);
  });
});

describe("one source of truth", () => {
  it("strats buyback --execute refuses, in one sentence, while the droplet may be paying out", () => {
    const sentence = /^The droplet does the buybacks for this bot, so nothing is paid from here; to do one by hand, turn auto-buyback off \(strats config auto-buyback off\) and run strats deploy\.$/;
    // On and deployed; on here but not sent yet; off here but the droplet still has it.
    assert.match(executeRefusal(baseBot({ autoBuyback: true, deployment: { ...DEPLOYMENT, autoBuyback: true } }))!, sentence);
    assert.match(executeRefusal(baseBot({ autoBuyback: true, deployment: DEPLOYMENT }))!, sentence);
    assert.match(executeRefusal(baseBot({ autoBuyback: false, deployment: { ...DEPLOYMENT, autoBuyback: true } }))!, sentence);
    // Off everywhere, or no droplet at all: the creator's machine is the one place that pays.
    assert.equal(executeRefusal(baseBot({ deployment: DEPLOYMENT })), null);
    assert.equal(executeRefusal(baseBot({ autoBuyback: false, deployment: { ...DEPLOYMENT, autoBuyback: false } })), null);
    assert.equal(executeRefusal(baseBot({ autoBuyback: true })), null);
    assert.equal(executeRefusal(baseBot()), null);
    assert.equal(dropletBuysBack(baseBot({ autoBuyback: true })), false);
  });

  it("status and config say who pays out, and when the droplet's setting lags this machine's", () => {
    assert.match(describeAutoBuyback(baseBot()), /^off: nothing is paid out until you run strats buyback --execute$/);
    assert.match(describeAutoBuyback(baseBot({ autoBuyback: true, deployment: { ...DEPLOYMENT, autoBuyback: true } })), /^on: once a day .* at least \$25$/);
    assert.match(describeAutoBuyback(baseBot({ autoBuyback: true, deployment: DEPLOYMENT })), /The droplet still has it off, until the next: strats deploy$/);
    assert.match(describeAutoBuyback(baseBot({ deployment: { ...DEPLOYMENT, autoBuyback: true } })), /^off: .*The droplet still has it on, until the next: strats deploy$/);
    assert.match(payoutNote(baseBot()), /Nothing is paid out by itself/);
    assert.match(payoutNote(baseBot({ autoBuyback: true, deployment: { ...DEPLOYMENT, autoBuyback: true } })), /The droplet pays out by itself/);
  });

  it("asks the founder's question for a Hyperliquid bot, and a true one for a bot whose key is already on the droplet", () => {
    assert.equal(autoBuybackQuestion(baseBot()), "Buy back automatically? This puts your wallet key on your droplet, so the droplet can withdraw.");
    assert.match(autoBuybackQuestion(themeBot()), /^Buy back automatically\? Your droplet already holds this bot's wallet key/);
  });

  it("keeps the choice in the bot file, and a bot file from before 0.5.0 reads as off", () => {
    assert.equal(BotStateSchema.parse(baseBot()).autoBuyback, undefined);
    assert.equal(BotStateSchema.parse(baseBot({ autoBuyback: true })).autoBuyback, true);
    assert.equal(BotStateSchema.parse(baseBot({ deployment: DEPLOYMENT })).deployment?.autoBuyback, undefined);
  });
});

describe("the payout record between the two machines", () => {
  let home: string;
  const savedHome = process.env.STRATS_HOME;
  beforeEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = mkdtempSync(join(tmpdir(), "strats-auto-record-"));
    process.env.STRATS_HOME = home;
    ensureHome();
  });
  after(() => {
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.STRATS_HOME; else process.env.STRATS_HOME = savedHome;
  });

  const withdrawal = (id: string, usd = 350): LedgerLine => ({ v: 1, type: "withdrawal", id, at: "2026-09-10T00:00:00.000Z", venue: "hyperliquid", usd, feeUsd: 1, profitSettledUsd: 500, buybackPct: 70 });
  const bought = (id: string, spentUsd = 349): LedgerLine => ({ v: 1, type: "buyback", id, at: "2026-09-10T00:10:00.000Z", spentUsd, fromChainId: 42161, token: { chainId: 8453, address: TOKEN }, destination: DEST, received: "1000", decimals: 18, txHash: `0x${"ab".repeat(32)}`, tool: "relay" });
  const bot = baseBot({ autoBuyback: true, deployment: { ...DEPLOYMENT, autoBuyback: true } });

  it("travels to the droplet as one file with no secret: the record so far and the deposits figure", () => {
    appendLedger("alpha", withdrawal("p1"));
    saveRuntimeState("alpha", { ...emptyRuntimeState(), netDepositsUsd: 1000, netDepositsAt: "2026-09-01T00:00:00.000Z" });
    const calls: Array<{ command: string; stdin: string | undefined }> = [];
    const exec: Exec = (_target, command, stdin) => {
      calls.push({ command, stdin });
      return { ok: true, code: 0, stdout: "", stderr: "" };
    };
    assert.deepEqual(pushBasis(bot, {}, exec), { ok: true });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.command, /\/var\/lib\/strats\/state\/alpha\.buyback-basis\.json'$/);
    const sent = BasisSchema.parse(JSON.parse(calls[0]!.stdin!));
    assert.equal(sent.netDepositsUsd, 1000);
    assert.deepEqual(sent.ledger.map((l) => l.id), ["p1"]);
    assert.equal(sent.hold, undefined);
    assert.doesNotMatch(calls[0]!.stdin!, /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])|qsk_/, "no key-shaped value");
    // strats fund pauses the droplet first.
    pushBasis(bot, { hold: true }, exec);
    assert.equal(BasisSchema.parse(JSON.parse(calls[1]!.stdin!)).hold, true);
    assert.deepEqual(pushBasis(baseBot(), {}, exec), { ok: false, message: "this bot is not deployed" });
  });

  it("is merged on the droplet without ever counting a payout twice, and the next report shows what was bought back", () => {
    const basis: BuybackBasis = { v: 1, at: new Date(T0).toISOString(), ledger: [withdrawal("p1"), bought("p1")] };
    saveBasis("alpha", basis);
    assert.deepEqual(loadBasis("alpha"), basis);
    assert.equal(mergeBasisLedger("alpha", basis), 2);
    assert.equal(mergeBasisLedger("alpha", basis), 0);
    // The droplet's own buyback is appended to the same record.
    appendLedger("alpha", withdrawal("p2", 100));
    appendLedger("alpha", bought("p2", 99));
    assert.equal(mergeBasisLedger("alpha", basis), 0);
    assert.equal(readLedger("alpha").lines.length, 4);
    assert.equal(readPayoutSummary("alpha").boughtBackUsd, 448);
    assert.equal(withPayouts({ venue: "hyperliquid", equityUsd: 1, netDepositsUsd: 1, volumeUsd: 0, openPositions: 0 }, "alpha").boughtBackUsd, 448);
    assert.equal(loadBasis("missing"), null);
  });

  it("refuses to send a record with a line it cannot read", () => {
    appendLedger("alpha", withdrawal("p1"));
    appendFileSync(join(home, "state", "alpha.payouts.jsonl"), '{"v":1,"type":"withdr\n');
    assert.throws(() => buildBasis("alpha"), /cannot be read/);
    let called = false;
    const result = pushBasis(bot, {}, () => {
      called = true;
      return { ok: true, code: 0, stdout: "", stderr: "" };
    });
    assert.ok(!result.ok && /cannot be read/.test(result.message));
    assert.equal(called, false, "nothing was sent");
  });

  it("comes home before the droplet is replaced: its lines are added once, and a part-way buyback moves here and leaves there", () => {
    appendLedger("alpha", withdrawal("p1"));
    const remoteLedger = [withdrawal("p1"), bought("p1"), withdrawal("p2", 100)].map((l) => JSON.stringify(l)).join("\n");
    const remoteJournal = JSON.stringify(journalAt("arrived"));
    const commands: string[] = [];
    const exec: Exec = (_target, command) => {
      commands.push(command);
      const stdout = command.includes("payouts.jsonl") ? remoteLedger : command.startsWith("if") && command.includes("buyback.json") ? remoteJournal : "";
      return { ok: true, code: 0, stdout, stderr: "" };
    };
    assert.deepEqual(pullRecord(bot, { moveJournal: false }, exec), { ok: true, added: 2, journal: "left", stage: "arrived" });
    assert.equal(fileJournal("alpha").load(), null, "left on the droplet");
    assert.equal(commands.some((c) => c.startsWith("rm ")), false);
    assert.deepEqual(pullRecord(bot, { moveJournal: true }, exec), { ok: true, added: 0, journal: "moved", stage: "arrived" });
    assert.equal(fileJournal("alpha").load()?.stage, "arrived");
    assert.equal(commands.at(-1), "rm -f '/var/lib/strats/state/alpha.buyback.json'");
    assert.equal(readLedger("alpha").lines.length, 3);
  });

  it("fails loudly, and changes nothing, when the droplet cannot be read or its record is damaged", () => {
    const down: Exec = () => ({ ok: false, code: 255, stdout: "", stderr: "ssh: connect to host 203.0.113.5 port 22: Operation timed out" });
    const result = pullRecord(bot, { moveJournal: true }, down);
    assert.ok(!result.ok && /timed out/.test(result.message));
    const damaged: Exec = (_t, command) => ({ ok: true, code: 0, stdout: command.includes("payouts.jsonl") ? `${JSON.stringify(withdrawal("p9"))}\n{"v":1,"type":"withdr` : "", stderr: "" });
    const second = pullRecord(bot, { moveJournal: true }, damaged);
    assert.ok(!second.ok && /could not be read/.test(second.message));
    assert.equal(readLedger("alpha").lines.length, 0);
  });

  it("finds the droplet's last buyback line in its log", () => {
    let asked = "";
    const exec: Exec = (_t, command) => {
      asked = command;
      return { ok: true, code: 0, stdout: "2026-09-19T14:10:00.000Z  buyback  Bought 1,000,000 TKN for $349.00. They are at 0xd2 on Base.\n", stderr: "" };
    };
    assert.match(lastBuybackLine(bot, exec), /buyback {2}Bought 1,000,000 TKN/);
    assert.match(asked, /journalctl -u strats@alpha --since '3 days ago' .*grep -F ' {2}buyback {2}' \| tail -n 1$/);
    assert.equal(lastBuybackLine(baseBot(), exec), "");
  });
});
