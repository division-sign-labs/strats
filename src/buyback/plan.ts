// The money arithmetic of a buyback. Pure: numbers in, a plan out. Every input
// is read on this machine or from the venue; nothing here comes from Quotient.
//
//   profit        = wallet value now - (deposits less withdrawals)
//   to split now  = profit - what earlier buybacks already split, never below zero
//   buyback share = to split now x the pinned buyback percent
//   withdrawn     = the buyback share, or the free collateral when that is less, cut to whole cents
//
// A withdrawal lowers the wallet value and the deposits figure by the same
// amount, so profit does not move, and the whole split is recorded as settled the
// moment the money leaves. The next run therefore starts from zero.

export type BuybackVenue = "hyperliquid" | "polymarket";

/** Hyperliquid keeps this from every withdrawal to Arbitrum. */
export const HYPERLIQUID_WITHDRAWAL_FEE_USD = 1;
export const MIN_USD_DEFAULT = 25;
export const MIN_USD_FLOOR = 10;

export interface PlanInput {
  venue: BuybackVenue;
  /** The same wallet value the report carries. */
  equityUsd: number;
  /** Deposits less withdrawals. */
  basisUsd: number;
  /** Profit that earlier buybacks already split. */
  settledUsd: number;
  /** Collateral not tied up in positions. Only this can be withdrawn. */
  freeUsd: number;
  buybackPct: number;
  minUsd: number;
}

export interface Plan extends PlanInput {
  profitUsd: number;
  distributableUsd: number;
  /** The buyback share before the free-collateral limit. */
  wantUsd: number;
  /** W: what leaves the venue. */
  withdrawUsd: number;
  feeUsd: number;
  /** A: what reaches the wallet, and exactly what is swapped. */
  arriveUsd: number;
  /** A in units of the 6-decimal source token. */
  arriveUnits: bigint;
  /** The profit this payout settles, both shares together. */
  profitSettledUsd: number;
  /** The kept share. It stays in the venue; nothing is moved. */
  keepUsd: number;
  /** True when the free collateral, not the split, set the amount. */
  clamped: boolean;
  /** Why nothing is paid, or null when the payout can go ahead. */
  refusal: "zero-share" | "below-minimum" | null;
}

const toCents = (usd: number): number => Math.floor(usd * 100 + 1e-7);
const round = (usd: number): number => Math.round(usd * 100) / 100;

export function planBuyback(input: PlanInput): Plan {
  const profitUsd = round(input.equityUsd - input.basisUsd);
  const distributableUsd = round(Math.max(0, profitUsd - input.settledUsd));
  const wantUsd = (distributableUsd * input.buybackPct) / 100;
  const freeUsd = Math.max(0, input.freeUsd);
  const clamped = wantUsd > freeUsd;
  const withdrawCents = Math.max(0, toCents(Math.min(wantUsd, freeUsd)));
  const withdrawUsd = withdrawCents / 100;
  const feeUsd = input.venue === "hyperliquid" ? HYPERLIQUID_WITHDRAWAL_FEE_USD : 0;
  const arriveCents = Math.max(0, withdrawCents - Math.round(feeUsd * 100));
  // Unclamped, the whole amount to split is settled. Clamped, only the part this withdrawal stands for.
  const profitSettledUsd = input.buybackPct <= 0 ? 0 : clamped ? round(Math.min(distributableUsd, (withdrawUsd * 100) / input.buybackPct)) : distributableUsd;
  const refusal = input.buybackPct <= 0 ? "zero-share" : withdrawUsd < input.minUsd ? "below-minimum" : null;
  return {
    ...input, freeUsd, profitUsd, distributableUsd, wantUsd: round(wantUsd), withdrawUsd, feeUsd,
    arriveUsd: arriveCents / 100,
    // Whole cents of a 6-decimal token: one cent is 10,000 units.
    arriveUnits: BigInt(arriveCents) * 10_000n,
    profitSettledUsd,
    keepUsd: round(Math.max(0, profitSettledUsd - withdrawUsd)),
    clamped, refusal,
  };
}

/** The sentence for a payout that cannot go ahead. */
export function refusalText(plan: Plan, usd: (value: number) => string): string | null {
  if (plan.refusal === "zero-share") return "The pinned split sends 0% to buybacks. Nothing to do.";
  if (plan.refusal === "below-minimum") return `The buyback share is ${usd(plan.withdrawUsd)}. Under ${usd(plan.minUsd)} it is not worth the fees. Nothing to do.`;
  return null;
}
