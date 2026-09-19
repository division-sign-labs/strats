// The buyback sequence with every outside thing faked: the venue, the wallet,
// LI.FI, the clock, the journal file and the payout record. Nothing is signed
// or sent anywhere.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JournalSchema, type Journal, type Stage } from "../src/buyback/journal.js";
import { QuoteSchema, floorFrom, type Quote, type SwapStatus } from "../src/buyback/lifi.js";
import { WITHDRAW_EVIDENCE_MS, WithdrawNotSentError, resumePayout, startPayout, tokenAmount, type BuybackDeps, type PayoutParams } from "../src/buyback/machine.js";
import type { LedgerLine } from "../src/payouts.js";

const T0 = Date.parse("2026-09-19T14:00:00.000Z");
const WALLET = `0x${"a1".repeat(20)}`;
const DEST = `0x${"d2".repeat(20)}`;
const TOKEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const A = 196_470_000n;
const MIN_OUT = 1_000_000n * 10n ** 18n;

const quoteOf = (minOut: bigint = MIN_OUT): Quote => QuoteSchema.parse({
  tool: "relay",
  action: { fromChainId: 42161, toChainId: 8453, fromToken: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", chainId: 42161, symbol: "USDC", decimals: 6 }, toToken: { address: TOKEN, chainId: 8453, symbol: "TKN", decimals: 18 }, fromAmount: A.toString(), fromAddress: WALLET, toAddress: DEST, slippage: 0.01 },
  estimate: { approvalAddress: DIAMOND, toAmount: (minOut + 10n ** 18n).toString(), toAmountMin: minOut.toString(), fromAmountUSD: "196.47", toAmountUSD: "195.00", executionDuration: 11, feeCosts: [], gasCosts: [] },
  includedSteps: [{ type: "cross", tool: "relay" }],
  transactionRequest: { to: DIAMOND, from: WALLET, chainId: 42161, data: "0xabcdef", value: "0x0" },
});

const params = (over: Partial<PayoutParams> = {}): PayoutParams => ({
  id: "2026-09-19T14:00:00.000Z-ab12", dex: "xyz", withdrawUsd: 197.47, feeUsd: 1, arriveUnits: A, profitSettledUsd: 282.1, buybackPct: 70,
  token: { chainId: 8453, address: TOKEN }, destination: DEST, floorMinOut: floorFrom(quoteOf()), tokenSymbol: "TKN", tokenDecimals: 18, ...over,
});

const journalAt = (stage: Stage, over: Partial<Journal> = {}): Journal => JournalSchema.parse({
  v: 1, id: params().id, startedAt: new Date(T0).toISOString(), venue: "hyperliquid", dex: "xyz", withdrawUsd: 197.47, arriveUnits: A.toString(), feeUsd: 1,
  profitSettledUsd: 282.1, buybackPct: 70, token: { chainId: 8453, address: TOKEN }, destination: DEST, tokenSymbol: "TKN", tokenDecimals: 18,
  floorMinOut: floorFrom(quoteOf()).toString(), walletBalanceBeforeUnits: "5000000", stage, ...over,
});
const hashOf = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;

interface World {
  deps: BuybackDeps;
  /** Everything that happened, in order. */
  events: string[];
  printed: string[];
  journal: () => Journal | null;
  ledger: LedgerLine[];
  wallet: { balance: bigint; allowance: bigint; mined: number; receipts: Map<string, "success" | "reverted"> };
  knobs: {
    withdraw: () => Promise<void>;
    evidence: "withdrawn" | "moved-to-main" | "none";
    /** What a broadcast does to the chain. The default mines it successfully. */
    onBroadcast: (raw: string, hash: string) => void;
    quotes: Array<Quote | string[]>;
    statuses: SwapStatus[];
    confirm: boolean;
    /** The withdrawal shows up in the wallet after this many balance reads. */
    arrivesAfterReads: number;
  };
}

function world(start: Journal | null = null): World {
  let now = T0;
  let saved = start;
  let signedCount = 0;
  let balanceReads = 0;
  let withdrawn = false;
  const events: string[] = [];
  const printed: string[] = [];
  const ledger: LedgerLine[] = [];
  const hashes = new Map<string, string>();
  const wallet = { balance: 5_000_000n, allowance: 0n, mined: 7, receipts: new Map<string, "success" | "reverted">() };
  const knobs: World["knobs"] = {
    withdraw: async () => undefined,
    evidence: "none",
    onBroadcast: (raw, hash) => {
      wallet.receipts.set(hash, "success");
      wallet.mined += 1;
      if (raw.startsWith("approve")) wallet.allowance = BigInt(raw.split(":")[1]!);
    },
    quotes: [],
    statuses: [{ state: "done", received: (MIN_OUT + 5n).toString(), tool: "relay" }],
    confirm: true,
    arrivesAfterReads: 2,
  };
  const sign = (raw: string): { raw: string; hash: string } => {
    signedCount += 1;
    const signed = { raw: `${raw}:${signedCount}`, hash: hashOf(signedCount) };
    hashes.set(signed.raw, signed.hash);
    return signed;
  };
  const deps: BuybackDeps = {
    venue: {
      name: "hyperliquid", label: "Hyperliquid",
      withdraw: async (usdAmount) => {
        events.push(`withdraw:${usdAmount}`);
        await knobs.withdraw();
        withdrawn = true;
      },
      evidence: async () => {
        events.push("evidence");
        return knobs.evidence;
      },
    },
    wallet: {
      address: WALLET, chainId: 42161, chainName: "Arbitrum", sourceSymbol: "USDC", explorerAddressUrl: `https://arbiscan.io/address/${WALLET}`,
      sourceBalance: async () => {
        balanceReads += 1;
        return wallet.balance + (withdrawn && balanceReads > knobs.arrivesAfterReads ? A : 0n);
      },
      allowance: async () => wallet.allowance,
      minedNonce: async () => wallet.mined,
      nextNonce: async () => wallet.mined,
      signApprove: async (amount, nonce) => {
        events.push(`sign-approve:${amount}:${nonce}`);
        return sign(`approve:${amount}:${nonce}`);
      },
      signSwap: async (tx, nonce) => {
        events.push(`sign-swap:${tx.to}:${nonce}`);
        return sign(`swap:${nonce}`);
      },
      broadcast: async (raw) => {
        events.push(`broadcast:${raw.split(":")[0]}`);
        knobs.onBroadcast(raw, hashes.get(raw)!);
      },
      receipt: async (hash) => wallet.receipts.get(hash) ?? null,
    },
    lifi: {
      quote: async (amount, floor) => {
        events.push(`quote:${amount}:${floor === undefined ? "no-floor" : "floor"}`);
        const next = knobs.quotes.shift() ?? quoteOf();
        if (Array.isArray(next)) return { ok: false, reasons: next };
        if (floor !== undefined && BigInt(next.estimate.toAmountMin) < floor) return { ok: false, reasons: ["the price moved: the quote now promises less than the least you agreed to"] };
        return { ok: true, quote: next };
      },
      status: async (hash) => {
        events.push(`status:${hash}`);
        return knobs.statuses.length > 1 ? knobs.statuses.shift()! : knobs.statuses[0]!;
      },
    },
    clock: { now: () => now, sleep: async (ms) => { now += ms; } },
    journal: {
      load: () => saved,
      create: (j) => {
        if (saved) throw new Error("A buyback is already in flight.");
        saved = JournalSchema.parse(j);
        events.push(`journal:${j.stage}`);
      },
      save: (j) => {
        saved = JournalSchema.parse(j);
        events.push(`journal:${j.stage}`);
      },
      remove: () => {
        saved = null;
        events.push("journal:removed");
      },
    },
    ledger: {
      has: (type, id) => ledger.some((l) => l.type === type && l.id === id),
      append: (line) => {
        ledger.push(line);
        events.push(`ledger:${line.type}`);
      },
    },
    sync: () => void events.push("sync"),
    print: (line) => void printed.push(line),
    progress: () => undefined,
    confirm: async () => {
      events.push("confirm");
      return knobs.confirm;
    },
    describeQuote: () => ["Route", "Quote"],
    tokenChainName: "Base",
  };
  // A journal past the withdrawal means the money has left the venue.
  if (start && start.stage !== "confirmed" && start.stage !== "withdraw_sending") withdrawn = true;
  return { deps, events, printed, journal: () => saved, ledger, wallet, knobs };
}

const before = (events: string[], first: string, second: string): boolean => {
  const a = events.indexOf(first);
  const b = events.indexOf(second);
  return a !== -1 && b !== -1 && a < b;
};

describe("a buyback from start to finish", () => {
  it("withdraws once, approves exactly the payout, swaps, records both lines, and leaves no journal", async () => {
    const w = world();
    const outcome = await startPayout(w.deps, params());
    assert.deepEqual(outcome, { code: 0 });
    assert.equal(w.journal(), null);
    assert.deepEqual(w.events.filter((e) => e.startsWith("withdraw:")), ["withdraw:197.47"]);
    assert.deepEqual(w.events.filter((e) => e.startsWith("sign-")), [`sign-approve:${A}:7`, `sign-swap:${DIAMOND}:8`]);
    assert.deepEqual(w.ledger.map((l) => l.type), ["withdrawal", "buyback"]);
    const [withdrawal, bought] = w.ledger;
    assert.ok(withdrawal?.type === "withdrawal" && withdrawal.usd === 197.47 && withdrawal.feeUsd === 1 && withdrawal.profitSettledUsd === 282.1 && withdrawal.buybackPct === 70);
    assert.ok(bought?.type === "buyback" && bought.spentUsd === 196.47 && bought.received === (MIN_OUT + 5n).toString() && bought.destination === DEST && bought.fromChainId === 42161 && bought.txHash === hashOf(2));
    assert.equal(w.events.filter((e) => e === "sync").length, 2);
    assert.equal(w.events.includes("confirm"), false, "the question was already asked before the payout started");
    assert.match(w.printed.at(-1)!, /^Bought 1,000,000 TKN for \$196\.47\. They are at 0xd2d2.* on Base\.$/);
    assert.ok(w.printed.includes("Withdrawal sent.") && w.printed.includes("Approved.") && w.printed.includes(`Swap sent: ${hashOf(2)}`));
  });

  it("saves the next stage before each action, and a signed transaction's hash before it is broadcast", async () => {
    const w = world();
    await startPayout(w.deps, params());
    assert.deepEqual(w.events.filter((e) => e.startsWith("journal:")), [
      "journal:confirmed", "journal:withdraw_sending", "journal:withdraw_sent", "journal:arrived", "journal:approve_sending", "journal:approved", "journal:swap_sending", "journal:swap_sent", "journal:removed",
    ]);
    assert.ok(before(w.events, "journal:withdraw_sending", "withdraw:197.47"));
    assert.ok(before(w.events, "journal:withdraw_sent", "ledger:withdrawal"));
    assert.ok(before(w.events, "ledger:withdrawal", "journal:arrived"), "the withdrawal is recorded before any swap is thought about");
    assert.ok(before(w.events, "journal:approve_sending", "broadcast:approve"));
    assert.ok(before(w.events, "journal:swap_sending", "broadcast:swap"));
  });

  it("checks the price again after the withdrawal arrives, against the floor the user agreed to", async () => {
    const w = world();
    await startPayout(w.deps, params());
    assert.equal(w.events.find((e) => e.startsWith("quote:")), `quote:${A}:floor`);
  });

  it("reuses an approval left over from a stopped run", async () => {
    const w = world();
    w.wallet.allowance = A;
    await startPayout(w.deps, params());
    assert.equal(w.events.some((e) => e.startsWith("sign-approve")), false);
    assert.equal(w.events.filter((e) => e.startsWith("sign-swap")).length, 1);
  });

  it("swaps the recorded amount, never whatever the wallet holds", async () => {
    const w = world();
    w.wallet.balance = 9_999_000_000n;
    await startPayout(w.deps, params());
    assert.ok(w.events.includes(`sign-approve:${A}:7`));
    assert.ok(w.events.every((e) => !e.startsWith("quote:") || e.startsWith(`quote:${A}:`)));
  });

  it("refuses to start while another buyback is in flight", async () => {
    const w = world(journalAt("arrived"));
    await assert.rejects(() => startPayout(w.deps, params()), /already in flight/);
    assert.deepEqual(w.events, []);
  });
});

describe("the withdrawal", () => {
  it("that was certainly not sent ends the buyback: no journal, no record, exit 1", async () => {
    const w = world();
    w.knobs.withdraw = async () => { throw new WithdrawNotSentError("insufficient withdrawable balance: 3 USDC"); };
    assert.deepEqual(await startPayout(w.deps, params()), { code: 1 });
    assert.equal(w.journal(), null);
    assert.deepEqual(w.ledger, []);
    assert.ok(w.printed.includes("Nothing left Hyperliquid."));
  });

  it("with an unknown result is never sent again: the journal stays, and the next run looks for evidence", async () => {
    const w = world();
    w.knobs.withdraw = async () => { throw new Error("socket hang up"); };
    assert.deepEqual(await startPayout(w.deps, params()), { code: 3 });
    assert.equal(w.journal()?.stage, "withdraw_sending");
    assert.deepEqual(w.ledger, []);

    w.events.length = 0;
    assert.deepEqual(await resumePayout(w.deps, w.journal()!), { code: 3 });
    assert.equal(w.events.some((e) => e.startsWith("withdraw:")), false);
    assert.ok(w.events.includes("evidence"));
    assert.ok(w.printed.includes("Still checking whether the withdrawal went out. Run it again in a few minutes."));
    assert.equal(w.journal()?.stage, "withdraw_sending");
  });

  it("found in the venue's history is recorded once and the buyback continues", async () => {
    const w = world(journalAt("withdraw_sending"));
    w.knobs.evidence = "withdrawn";
    w.knobs.arrivesAfterReads = 0;
    w.wallet.balance = 5_000_000n;
    // The money is not in the wallet on the first look, so the venue's history is asked.
    const looks = [5_000_000n, 5_000_000n + A];
    w.deps.wallet.sourceBalance = async () => looks.shift() ?? 5_000_000n + A;
    assert.deepEqual(await resumePayout(w.deps, w.journal()!), { code: 0 });
    assert.equal(w.events.some((e) => e.startsWith("withdraw:")), false);
    assert.equal(w.ledger.filter((l) => l.type === "withdrawal").length, 1);
    assert.ok(w.events.includes("confirm"), "a resumed run asks again before it approves or swaps");
  });

  it("that shows up in the wallet is evidence by itself, which is all a Polymarket bot has", async () => {
    const w = world(journalAt("withdraw_sending", { venue: "polymarket", dex: undefined }));
    w.deps.wallet.sourceBalance = async () => 5_000_000n + A;
    assert.deepEqual(await resumePayout(w.deps, w.journal()!), { code: 0 });
    assert.equal(w.events.includes("evidence"), false);
    assert.equal(w.ledger.filter((l) => l.type === "withdrawal").length, 1);
  });

  it("with no trace after 30 minutes never happened: the journal goes and nothing is recorded", async () => {
    const w = world(journalAt("withdraw_sending", { startedAt: new Date(T0 - WITHDRAW_EVIDENCE_MS - 1).toISOString() }));
    assert.deepEqual(await resumePayout(w.deps, w.journal()!), { code: 1 });
    assert.equal(w.journal(), null);
    assert.deepEqual(w.ledger, []);
    assert.ok(w.printed.includes("The withdrawal never happened. Nothing moved."));
  });

  it("that only got as far as the main Hyperliquid account says where the money is", async () => {
    const w = world(journalAt("withdraw_sending", { startedAt: new Date(T0 - WITHDRAW_EVIDENCE_MS - 1).toISOString() }));
    w.knobs.evidence = "moved-to-main";
    assert.deepEqual(await resumePayout(w.deps, w.journal()!), { code: 3 });
    assert.equal(w.journal(), null);
    assert.deepEqual(w.ledger, []);
    assert.match(w.printed.at(-1)!, /moved from the "xyz" dex to your main Hyperliquid account and is still there\. Nothing left Hyperliquid\. To move it back to the dex: strats fund/);
  });

  it("that does not arrive in 20 minutes stops with the money on its way", async () => {
    const w = world();
    w.knobs.arrivesAfterReads = Number.MAX_SAFE_INTEGER;
    assert.deepEqual(await startPayout(w.deps, params()), { code: 3 });
    assert.equal(w.journal()?.stage, "withdraw_sent");
    assert.equal(w.ledger.length, 1, "the withdrawal is recorded even though no swap happened");
    assert.equal(w.printed.at(-1), `The withdrawal of $197.47 is on its way to your wallet ${WALLET} on Arbitrum. Run strats buyback --execute again to continue.`);
  });
});

describe("running it again", () => {
  it("after a confirmation that sent nothing drops the journal and asks for a new plan", async () => {
    const w = world(journalAt("confirmed"));
    assert.deepEqual(await resumePayout(w.deps, w.journal()!), { code: "replan" });
    assert.equal(w.journal(), null);
    assert.equal(w.events.some((e) => e.startsWith("withdraw:")), false);
  });

  it("says that it is continuing, and when the buyback started", async () => {
    const w = world(journalAt("swap_sent", { swap: { nonce: 8, hash: hashOf(99), quoteMinOut: "1" } }));
    await resumePayout(w.deps, w.journal()!);
    assert.equal(w.printed[0], "Continuing the buyback started 2026-09-19T14:00:00.000Z.");
  });

  it("writes the withdrawal line if the stop came before it was written, and never a second one", async () => {
    const w = world(journalAt("withdraw_sent", { withdrawSentAt: new Date(T0).toISOString() }));
    w.deps.wallet.sourceBalance = async () => 5_000_000n + A;
    await resumePayout(w.deps, w.journal()!);
    assert.equal(w.ledger.filter((l) => l.type === "withdrawal").length, 1);

    const again = world(journalAt("arrived"));
    again.ledger.push({ v: 1, type: "withdrawal", id: params().id, at: new Date(T0).toISOString(), venue: "hyperliquid", usd: 197.47, feeUsd: 1, profitSettledUsd: 282.1, buybackPct: 70 });
    again.deps.wallet.sourceBalance = async () => 5_000_000n + A;
    await resumePayout(again.deps, again.journal()!);
    assert.equal(again.ledger.filter((l) => l.type === "withdrawal").length, 1);
  });

  it("with the money in the wallet shows the new quote and asks again; no means nothing is signed", async () => {
    const w = world(journalAt("arrived"));
    w.knobs.confirm = false;
    assert.deepEqual(await resumePayout(w.deps, w.journal()!), { code: 0 });
    assert.ok(w.events.includes(`quote:${A}:no-floor`));
    assert.ok(before(w.events, `quote:${A}:no-floor`, "confirm"));
    assert.equal(w.events.some((e) => e.startsWith("sign-") || e.startsWith("broadcast")), false);
    assert.equal(w.journal()?.stage, "arrived");
    assert.ok(w.printed.includes("Route") && w.printed.includes("Nothing was changed."));
    assert.equal(w.printed.at(-1), `$196.47 USDC is in your wallet ${WALLET} on Arbitrum. Nothing was swapped. Run strats buyback --execute again to continue, or move it yourself.`);
  });

  it("with the money in the wallet and a yes measures the floor from the quote that was shown, saves it, and finishes", async () => {
    const w = world(journalAt("arrived"));
    const cheaper = quoteOf(MIN_OUT / 2n);
    w.knobs.quotes = [cheaper];
    assert.deepEqual(await resumePayout(w.deps, w.journal()!), { code: 0 });
    assert.ok(before(w.events, "confirm", `sign-approve:${A}:7`));
    assert.deepEqual(w.ledger.map((l) => l.type), ["withdrawal", "buyback"]);
    const savedFloor = w.events.indexOf("journal:arrived");
    assert.ok(savedFloor !== -1 && savedFloor > w.events.indexOf("confirm"));
  });
});

describe("the price check after the money arrives", () => {
  it("stops before anything is signed when the quote promises less than the floor, and says where the money is", async () => {
    const w = world();
    w.knobs.quotes = [quoteOf(MIN_OUT / 2n)];
    assert.deepEqual(await startPayout(w.deps, params()), { code: 3 });
    assert.equal(w.events.some((e) => e.startsWith("sign-")), false);
    assert.equal(w.journal()?.stage, "arrived");
    assert.match(w.printed.at(-2)!, /^The swap was not sent: the price moved/);
    assert.match(w.printed.at(-1)!, /^\$196\.47 USDC is in your wallet .* Nothing was swapped\./);
  });

  it("stops the same way when any other check fails or no quote can be had", async () => {
    const w = world();
    w.knobs.quotes = [["the quote delivers to a different address"]];
    assert.deepEqual(await startPayout(w.deps, params()), { code: 3 });
    assert.equal(w.events.some((e) => e.startsWith("sign-")), false);
  });

  it("takes a new quote before the swap when the approval took longer than the quote stays fresh", async () => {
    const w = world();
    const mine = w.knobs.onBroadcast;
    w.knobs.onBroadcast = (raw, hash) => {
      mine(raw, hash);
      if (raw.startsWith("approve")) void w.deps.clock.sleep(60_000);
    };
    await startPayout(w.deps, params());
    assert.equal(w.events.filter((e) => e.startsWith("quote:")).length, 2);
    assert.ok(w.events.filter((e) => e.startsWith("quote:")).every((e) => e.endsWith(":floor")));
  });
});

describe("a transaction whose fate is unknown", () => {
  const stuck = (stage: "approve_sending" | "swap_sending", nonce = 7): Journal =>
    journalAt(stage, stage === "approve_sending" ? { approve: { nonce, hash: hashOf(500) } } : { swap: { nonce, hash: hashOf(500), quoteMinOut: MIN_OUT.toString(), tool: "relay" } });

  it("continues when the saved approval turns out to be mined", async () => {
    const w = world(stuck("approve_sending"));
    w.wallet.receipts.set(hashOf(500), "success");
    w.wallet.mined = 8;
    w.deps.wallet.sourceBalance = async () => 5_000_000n + A;
    assert.deepEqual(await resumePayout(w.deps, w.journal()!), { code: 0 });
    assert.equal(w.events.some((e) => e.startsWith("sign-approve")), false);
  });

  it("sends an approval that was never seen again only with the same nonce, after asking", async () => {
    const w = world(stuck("approve_sending", 7));
    w.wallet.mined = 7;
    await resumePayout(w.deps, w.journal()!);
    assert.ok(w.events.includes(`sign-approve:${A}:7`));
    assert.ok(before(w.events, "confirm", `sign-approve:${A}:7`));
    assert.equal(w.events.some((e) => /^sign-approve:\d+:(?!7$)/.test(e)), false);
  });

  it("stops when the nonce was used by something else, and signs nothing", async () => {
    for (const stage of ["approve_sending", "swap_sending"] as const) {
      const w = world(stuck(stage, 7));
      w.wallet.mined = 8;
      assert.deepEqual(await resumePayout(w.deps, w.journal()!), { code: 3 });
      assert.equal(w.events.some((e) => e.startsWith("sign-") || e.startsWith("broadcast")), false, stage);
      assert.equal(w.printed.at(-1), `Another transaction used this wallet. Check https://arbiscan.io/address/${WALLET} before running again.`);
      assert.equal(w.journal()?.stage, stage);
    }
  });

  it("goes on to LI.FI when the saved swap turns out to be mined, without signing again", async () => {
    const w = world(stuck("swap_sending", 8));
    w.wallet.receipts.set(hashOf(500), "success");
    w.wallet.mined = 9;
    assert.deepEqual(await resumePayout(w.deps, w.journal()!), { code: 0 });
    assert.equal(w.events.some((e) => e.startsWith("sign-")), false);
    assert.ok(w.events.includes(`status:${hashOf(500)}`));
    assert.equal(w.events.includes("confirm"), false);
  });

  it("quotes again, asks again, and re-signs a swap that was never seen with the same nonce, keeping the old hash", async () => {
    const w = world(stuck("swap_sending", 8));
    w.wallet.mined = 8;
    w.wallet.allowance = A;
    assert.deepEqual(await resumePayout(w.deps, w.journal()!), { code: 0 });
    assert.ok(before(w.events, `quote:${A}:no-floor`, "confirm"));
    assert.ok(before(w.events, "confirm", `sign-swap:${DIAMOND}:8`));
    assert.deepEqual(w.events.filter((e) => e.startsWith("sign-swap")), [`sign-swap:${DIAMOND}:8`]);
  });

  it("finds the older of two signatures when that is the one the chain took", async () => {
    const w = world(journalAt("swap_sending", { swap: { nonce: 8, hash: hashOf(501), earlier: [hashOf(500)], quoteMinOut: MIN_OUT.toString() } }));
    w.wallet.receipts.set(hashOf(500), "success");
    w.wallet.mined = 9;
    assert.deepEqual(await resumePayout(w.deps, w.journal()!), { code: 0 });
    assert.ok(w.events.includes(`status:${hashOf(500)}`), "LI.FI is asked about the transaction that was mined");
    assert.ok(w.ledger.some((l) => l.type === "buyback" && l.txHash === hashOf(500)));
  });

  it("treats a mined and failed transaction as final: the money is in the wallet and the next run starts from there", async () => {
    for (const stage of ["approve_sending", "swap_sending"] as const) {
      const w = world(stuck(stage, 7));
      w.wallet.receipts.set(hashOf(500), "reverted");
      w.wallet.mined = 8;
      assert.deepEqual(await resumePayout(w.deps, w.journal()!), { code: 3 });
      assert.equal(w.journal()?.stage, "arrived");
      assert.equal(w.journal()?.swap, undefined);
      assert.match(w.printed.join("\n"), new RegExp(`failed on Arbitrum \\(transaction ${hashOf(500)}\\)`));
      assert.match(w.printed.at(-1)!, /Nothing was swapped/);
    }
  });

  it("stops with the swap in flight when its receipt does not come, and a later run only looks", async () => {
    const w = world();
    w.knobs.onBroadcast = (raw, hash) => {
      if (raw.startsWith("approve")) { w.wallet.receipts.set(hash, "success"); w.wallet.mined += 1; w.wallet.allowance = A; }
    };
    assert.deepEqual(await startPayout(w.deps, params()), { code: 3 });
    assert.equal(w.journal()?.stage, "swap_sending");
    assert.equal(w.printed.at(-1), `The swap is in flight (transaction ${hashOf(2)}). Run strats buyback --execute again to check it.`);
  });

  it("does not take a node's refusal as proof that nothing was sent", async () => {
    const w = world();
    w.wallet.allowance = A;
    w.knobs.onBroadcast = () => { throw new Error("nonce too low"); };
    assert.deepEqual(await startPayout(w.deps, params()), { code: 3 });
    assert.equal(w.journal()?.stage, "swap_sending");
  });
});

describe("after the swap is sent", () => {
  const sent = (): Journal => journalAt("swap_sent", { swap: { nonce: 8, hash: hashOf(77), quoteMinOut: MIN_OUT.toString(), tool: "relay" } });

  it("only asks LI.FI, and stops with the swap in flight when 30 minutes pass", async () => {
    const w = world(sent());
    w.knobs.statuses = [{ state: "pending", detail: "waiting" }];
    assert.deepEqual(await resumePayout(w.deps, w.journal()!), { code: 3 });
    assert.ok(w.events.filter((e) => e.startsWith("status:")).length > 100);
    assert.equal(w.events.some((e) => e.startsWith("sign-") || e.startsWith("quote:") || e === "confirm"), false);
    assert.equal(w.journal()?.stage, "swap_sent");
    assert.equal(w.printed.at(-1), `The swap is in flight (transaction ${hashOf(77)}). Run strats buyback --execute again to check it.`);
  });

  it("records the purchase once, even if the line was written before a stop", async () => {
    const w = world(sent());
    w.ledger.push({ v: 1, type: "buyback", id: params().id, at: new Date(T0).toISOString(), spentUsd: 196.47, fromChainId: 42161, token: { chainId: 8453, address: TOKEN }, destination: DEST, received: "1", decimals: 18, txHash: hashOf(77), tool: "relay" });
    assert.deepEqual(await resumePayout(w.deps, w.journal()!), { code: 0 });
    assert.equal(w.ledger.filter((l) => l.type === "buyback").length, 1);
    assert.equal(w.journal(), null);
  });

  it("keeps the journal and says where a refund goes when LI.FI reports a failure and the money is not back", async () => {
    const w = world(sent());
    w.knobs.statuses = [{ state: "failed", detail: "The transfer failed." }];
    w.deps.wallet.sourceBalance = async () => 5_000_000n;
    assert.deepEqual(await resumePayout(w.deps, w.journal()!), { code: 3 });
    assert.equal(w.journal()?.stage, "swap_sent");
    assert.match(w.journal()?.note ?? "", /LI\.FI reports that the swap failed/);
    assert.match(w.printed.at(-1)!, new RegExp(`Any refund goes to your wallet ${WALLET} on Arbitrum`));
    assert.equal(w.ledger.some((l) => l.type === "buyback"), false);
  });

  it("goes back to 'the money is in the wallet' once a refund has arrived, so the next run can swap again", async () => {
    const w = world(sent());
    w.knobs.statuses = [{ state: "refunded", detail: "Refunded." }];
    w.deps.wallet.sourceBalance = async () => 5_000_000n + A;
    assert.deepEqual(await resumePayout(w.deps, w.journal()!), { code: 3 });
    assert.equal(w.journal()?.stage, "arrived");
    assert.equal(w.ledger.some((l) => l.type === "buyback"), false);
  });

  it("closes the payout without counting a purchase when the route delivered something else", async () => {
    const w = world(sent());
    w.knobs.statuses = [{ state: "other-token", detail: "LI.FI reports 196 of USDC on chain 8453." }];
    assert.deepEqual(await resumePayout(w.deps, w.journal()!), { code: 3 });
    assert.equal(w.journal(), null);
    assert.equal(w.ledger.some((l) => l.type === "buyback"), false);
    assert.match(w.printed.at(-1)!, /no purchase is recorded\. The withdrawal of \$197\.47 stays counted/);
  });
});

describe("tokenAmount", () => {
  it("shows whole tokens with separators when there are many, and four decimals when there are few", () => {
    assert.equal(tokenAmount("1204551000000000000000000", 18), "1,204,551");
    assert.equal(tokenAmount("1500000000000000000", 18), "1.5");
    assert.equal(tokenAmount("123456", 6), "0.1234");
    assert.equal(tokenAmount("0", 18), "0");
  });
});
