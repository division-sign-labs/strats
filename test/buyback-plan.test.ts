import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planBuyback, refusalText, type PlanInput } from "../src/buyback/plan.js";
import { depositsLessWithdrawals } from "../src/payouts.js";
import { usd } from "../src/reconcile.js";

const input = (over: Partial<PlanInput> = {}): PlanInput => ({ venue: "hyperliquid", equityUsd: 1482.1, basisUsd: 1000, settledUsd: 200, freeUsd: 1482.1, buybackPct: 70, minUsd: 25, ...over });

describe("planBuyback", () => {
  it("splits the profit that was not split before, by the pinned percent", () => {
    const plan = planBuyback(input());
    assert.equal(plan.profitUsd, 482.1);
    assert.equal(plan.distributableUsd, 282.1);
    assert.equal(plan.withdrawUsd, 197.47);
    assert.equal(plan.keepUsd, 84.63);
    assert.equal(plan.profitSettledUsd, 282.1);
    assert.equal(plan.clamped, false);
    assert.equal(plan.refusal, null);
  });

  it("takes Hyperliquid's one dollar off what arrives, and nothing off on Polymarket", () => {
    const hl = planBuyback(input());
    assert.equal(hl.feeUsd, 1);
    assert.equal(hl.arriveUsd, 196.47);
    assert.equal(hl.arriveUnits, 196_470_000n);
    const pm = planBuyback(input({ venue: "polymarket" }));
    assert.equal(pm.feeUsd, 0);
    assert.equal(pm.arriveUsd, 197.47);
    assert.equal(pm.arriveUnits, 197_470_000n);
  });

  it("cuts the withdrawal down to whole cents, never up", () => {
    const plan = planBuyback(input({ equityUsd: 1100.999, basisUsd: 1000, settledUsd: 0, buybackPct: 33 }));
    assert.equal(plan.distributableUsd, 101);
    assert.equal(plan.withdrawUsd, 33.33);
    assert.ok(plan.withdrawUsd <= (plan.distributableUsd * 33) / 100);
  });

  it("pays nothing on a loss, on profit already split, or on a negative remainder", () => {
    for (const over of [{ equityUsd: 900 }, { settledUsd: 482.1 }, { settledUsd: 9999 }]) {
      const plan = planBuyback(input(over));
      assert.equal(plan.distributableUsd, 0);
      assert.equal(plan.withdrawUsd, 0);
      assert.equal(plan.refusal, "below-minimum");
    }
  });

  it("refuses a share under the minimum, and says the amounts", () => {
    const plan = planBuyback(input({ equityUsd: 1230, settledUsd: 200 }));
    assert.equal(plan.withdrawUsd, 21);
    assert.equal(plan.refusal, "below-minimum");
    assert.equal(refusalText(plan, usd), "The buyback share is $21.00. Under $25.00 it is not worth the fees. Nothing to do.");
    assert.equal(planBuyback(input({ equityUsd: 1230, settledUsd: 200, minUsd: 10 })).refusal, null);
    assert.equal(planBuyback(input({ equityUsd: 1235.72, settledUsd: 200 })).refusal, null);
  });

  it("refuses a split that sends nothing to buybacks", () => {
    const plan = planBuyback(input({ buybackPct: 0 }));
    assert.equal(plan.refusal, "zero-share");
    assert.equal(plan.withdrawUsd, 0);
    assert.equal(plan.profitSettledUsd, 0);
    assert.equal(refusalText(plan, usd), "The pinned split sends 0% to buybacks. Nothing to do.");
  });

  it("uses only the free collateral when the rest is in positions, and settles only the profit that withdrawal stands for", () => {
    const plan = planBuyback(input({ freeUsd: 100 }));
    assert.equal(plan.clamped, true);
    assert.equal(plan.withdrawUsd, 100);
    assert.equal(plan.profitSettledUsd, 142.86);
    assert.equal(plan.keepUsd, 42.86);
    // The rest stays to be split once the positions close.
    const next = planBuyback(input({ equityUsd: 1382.1, basisUsd: 900, settledUsd: 200 + plan.profitSettledUsd, freeUsd: 1382.1 }));
    assert.equal(next.distributableUsd, 139.24);
  });

  it("never settles more than there was to split, and never withdraws more than is free", () => {
    for (const freeUsd of [0, 0.004, 10, 50.555, 197.47, 5000]) {
      const plan = planBuyback(input({ freeUsd }));
      assert.ok(plan.withdrawUsd <= freeUsd + 1e-9, String(freeUsd));
      assert.ok(plan.profitSettledUsd <= plan.distributableUsd + 1e-9, String(freeUsd));
      assert.ok(plan.arriveUsd <= plan.withdrawUsd);
    }
  });
});

describe("two buybacks in a row", () => {
  it("leave nothing to split the second time on Hyperliquid, where the venue's own history drops by the withdrawal", () => {
    const first = planBuyback(input());
    // The withdrawal lowers the account value and Hyperliquid's net deposits by the same amount.
    const second = planBuyback(input({ equityUsd: 1482.1 - first.withdrawUsd, basisUsd: 1000 - first.withdrawUsd, settledUsd: 200 + first.profitSettledUsd }));
    assert.equal(second.profitUsd, first.profitUsd);
    assert.equal(second.distributableUsd, 0);
    assert.equal(second.withdrawUsd, 0);
    assert.equal(second.refusal, "below-minimum");
  });

  it("leave nothing to split the second time on Polymarket, where the dated withdrawal is taken off the recorded deposits", () => {
    const recordedAt = "2026-09-01T00:00:00.000Z";
    const first = planBuyback(input({ venue: "polymarket", basisUsd: depositsLessWithdrawals(1000, recordedAt, []), settledUsd: 0 }));
    assert.equal(first.withdrawUsd, 337.47);
    const withdrawals = [{ at: "2026-09-19T12:00:00.000Z", usd: first.withdrawUsd }];
    const second = planBuyback(input({ venue: "polymarket", equityUsd: 1482.1 - first.withdrawUsd, basisUsd: depositsLessWithdrawals(1000, recordedAt, withdrawals), settledUsd: first.profitSettledUsd }));
    assert.equal(second.profitUsd, first.profitUsd);
    assert.equal(second.distributableUsd, 0);
    assert.equal(second.refusal, "below-minimum");
  });

  it("pay only the new profit after the account grows again", () => {
    const first = planBuyback(input({ settledUsd: 0 }));
    const later = planBuyback(input({ equityUsd: 1482.1 - first.withdrawUsd + 100, basisUsd: 1000 - first.withdrawUsd, settledUsd: first.profitSettledUsd }));
    assert.equal(later.distributableUsd, 100);
    assert.equal(later.withdrawUsd, 70);
  });
});

describe("deposits less withdrawals, for Polymarket", () => {
  const withdrawals = [{ at: "2026-09-10T00:00:00.000Z", usd: 100 }, { at: "2026-09-20T00:00:00.000Z", usd: 50 }];

  it("takes off only the withdrawals made after the deposits figure was recorded", () => {
    assert.equal(depositsLessWithdrawals(1000, "2026-09-15T00:00:00.000Z", withdrawals), 950);
    assert.equal(depositsLessWithdrawals(1000, "2026-09-25T00:00:00.000Z", withdrawals), 1000);
  });

  it("takes off every withdrawal when the figure has no date, or the date of --set-deposits", () => {
    assert.equal(depositsLessWithdrawals(1000, undefined, withdrawals), 850);
    assert.equal(depositsLessWithdrawals(1000, new Date(0).toISOString(), withdrawals), 850);
    assert.equal(depositsLessWithdrawals(1000, "not a date", withdrawals), 850);
  });
});
