// The decision function for the theme strategy. Pure: no I/O, no clock, no
// package imports beyond types. Each cycle the runner reads the targets and
// the wallet, calls this, and carries out the actions it returns.
//
// The rules, in the order they apply:
//   - A fetch failure, a document that does not parse, or one past validUntil: HOLD. Nothing opens, nothing closes.
//   - A held position whose market is in `closed`: redeem it when it is redeemable, otherwise sell it at the bid.
//   - A held position whose market is in `targets`: keep it, and sell it when the bid reaches takeProfitPrice.
//   - A held position the server did not name: left alone.
//   - A target that is not held: buy it once, never above maxPrice, only in "open" mode.
//   - Size per position is min(server positionPct, local ceiling, 50) percent of equity, and
//     everything held plus everything bought this cycle never exceeds 100 percent of equity.
import type { ThemeMarket, ThemeTargetsDoc } from "./protocol/index.js";

export const THEME_HARD_CAP_PCT = 50;
/** Polymarket rejects marketable orders under one dollar. */
export const THEME_MIN_ORDER_USD = 1;
/** Used when the book does not state a minimum order size. */
export const THEME_DEFAULT_MIN_SHARES = 5;
/** Keeps a cycle short and spreads entries over time. */
export const THEME_MAX_BUYS_PER_CYCLE = 3;

export type ThemeTargetsInput = { ok: true; doc: ThemeTargetsDoc } | { ok: false; reason: string };

export interface ThemeHolding {
  tokenId: string;
  /** Empty when the venue did not say. */
  conditionId: string;
  /** Shares. */
  size: number;
  /** Market has resolved and the shares can be redeemed. */
  redeemable: boolean;
}

export interface ThemeQuote {
  /** Best bid and ask, 0 when that side of the book is empty. */
  bid: number;
  ask: number;
  minShares?: number;
}

export interface ThemeReconcileInput {
  targets: ThemeTargetsInput;
  /** Epoch milliseconds. */
  now: number;
  /** The markets the creator configured. A target outside this list is refused. */
  markets: ThemeMarket[];
  holdings: ThemeHolding[];
  /** Keyed by token id. A token without a quote is neither bought nor sold this cycle. */
  quotes: Record<string, ThemeQuote>;
  /** Free collateral, USD. */
  collateralUsd: number;
  /** Collateral plus the value of every holding, USD. */
  equityUsd: number;
  /** Value of every holding, USD. */
  exposureUsd: number;
  positionPct: number;
  ceilingPct: number;
  /** Target ids already entered once, or with an order whose result is still unknown. */
  blockedTargetIds: string[];
  /** Condition ids whose redemption was already submitted. */
  redeemedConditionIds: string[];
  /** Token ids with one of our orders still resting. */
  pendingTokenIds: string[];
  /** A reason nothing may be opened right now. Sells and redemptions still run. */
  openBlockedReason?: string;
  /**
   * Single-asset markets only: the rule's floor and edge, held against the live book at the moment of the order. The targets document
   * is up to five minutes old, and a price that has fallen under the floor since is news the forecast has not seen.
   */
  entryRule?: { minBuyPrice: number; minEdge: number };
}

export type ThemeAction =
  | { kind: "buy"; targetId: string; conditionId: string; tokenId: string; outcome: string; question: string; limitPx: number; maxPrice: number; shares: number; budgetUsd: number }
  | { kind: "sell"; conditionId: string; tokenId: string; shares: number; minPrice: number; why: "take-profit" | "closed"; reason: string }
  | { kind: "redeem"; conditionId: string; tokenId: string; reason: string };

export interface ThemeDecision {
  /** Set when the whole cycle holds. `actions` is empty then. */
  hold: string | null;
  actions: ThemeAction[];
  /** Why a target was not bought or a holding not sold, one short sentence each. */
  notes: string[];
  kept: number;
}

export function themeEffectivePct(positionPct: number, ceilingPct: number): number {
  return Math.max(0, Math.min(positionPct, ceilingPct, THEME_HARD_CAP_PCT));
}

/** Null means act; a string is the reason to hold. */
export function themeHoldReason(targets: ThemeTargetsInput, now: number): string | null {
  if (!targets.ok) return targets.reason;
  const validUntil = Date.parse(targets.doc.validUntil);
  // A time that cannot be read is a fault, and a fault holds.
  if (!Number.isFinite(validUntil)) return "The targets carry no readable expiry time.";
  if (now > validUntil) return `The targets expired at ${targets.doc.validUntil}.`;
  return null;
}

/** Whole cents of a share, rounded down, the way the venue counts them. */
export function floorShares(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value * 100 + 1e-7) / 100;
}

export function reconcileTheme(input: ThemeReconcileInput): ThemeDecision {
  const hold = themeHoldReason(input.targets, input.now);
  if (hold !== null || !input.targets.ok) return { hold: hold ?? "The targets could not be read.", actions: [], notes: [], kept: 0 };
  const doc = input.targets.doc;
  const actions: ThemeAction[] = [];
  const notes: string[] = [];
  let kept = 0;

  const held = input.holdings.filter((h) => h.size > 0);
  const heldByToken = new Map(held.map((h) => [h.tokenId, h]));
  const marketByCondition = new Map(input.markets.map((m) => [m.conditionId.toLowerCase(), m]));
  const marketOfToken = (tokenId: string): ThemeMarket | undefined => input.markets.find((m) => m.tokenIds.includes(tokenId));
  /** A market counts as held when either of its tokens is in the wallet. */
  const heldConditions = new Set<string>();
  for (const h of held) {
    const condition = (h.conditionId || marketOfToken(h.tokenId)?.conditionId || "").toLowerCase();
    if (condition) heldConditions.add(condition);
  }
  const isConfigured = (conditionId: string, tokenId: string): boolean => marketByCondition.get(conditionId.toLowerCase())?.tokenIds.includes(tokenId) === true;
  const pending = new Set(input.pendingTokenIds);
  const redeemed = new Set(input.redeemedConditionIds.map((c) => c.toLowerCase()));

  // Exits first. They run in both modes and never depend on the opening rules.
  for (const closed of doc.closed) {
    const holding = heldByToken.get(closed.tokenId);
    if (!holding) continue;
    // Only markets the creator configured are ever sold or redeemed, whatever the server names.
    if (!isConfigured(closed.conditionId, closed.tokenId)) { notes.push(`${short(closed.conditionId)}: not one of the configured markets, left alone.`); continue; }
    if (holding.redeemable) {
      if (redeemed.has(closed.conditionId.toLowerCase())) notes.push(`${short(closed.conditionId)}: the redemption was already submitted.`);
      else actions.push({ kind: "redeem", conditionId: closed.conditionId, tokenId: closed.tokenId, reason: closed.reason });
      continue;
    }
    const quote = input.quotes[closed.tokenId];
    if (pending.has(closed.tokenId)) notes.push(`${short(closed.conditionId)}: an order is still resting, waiting for it.`);
    else if (!quote || quote.bid <= 0) notes.push(`${short(closed.conditionId)}: closed, but there is no bid to sell into.`);
    else pushSell(actions, notes, holding, closed.conditionId, quote, "closed", closed.reason);
  }
  for (const target of doc.targets) {
    const holding = heldByToken.get(target.tokenId);
    if (!holding) continue;
    const quote = input.quotes[target.tokenId];
    if (!isConfigured(target.conditionId, target.tokenId)) {
      notes.push(`${short(target.conditionId)}: not one of the configured markets, left alone.`);
    } else if (quote && quote.bid >= target.takeProfitPrice && !pending.has(target.tokenId)) {
      pushSell(actions, notes, holding, target.conditionId, quote, "take-profit", `The bid ${quote.bid} reached the take-profit price ${target.takeProfitPrice}.`);
    } else {
      kept += 1;
    }
  }

  // Entries.
  if (doc.mode !== "open") {
    if (doc.targets.length > 0) notes.push("Reduce-only mode: nothing is opened.");
    return { hold: null, actions, notes, kept };
  }
  if (input.openBlockedReason) {
    notes.push(input.openBlockedReason);
    return { hold: null, actions, notes, kept };
  }
  const pct = themeEffectivePct(input.positionPct, input.ceilingPct);
  const perPositionUsd = (input.equityUsd * pct) / 100;
  const blocked = new Set(input.blockedTargetIds);
  let collateralLeft = input.collateralUsd;
  let exposure = input.exposureUsd;
  let buys = 0;

  for (const target of doc.targets) {
    const label = short(target.conditionId);
    const condition = target.conditionId.toLowerCase();
    if (heldByToken.has(target.tokenId) || heldConditions.has(condition)) continue;
    const market = marketByCondition.get(condition);
    if (!market) { notes.push(`${label}: not one of the configured markets, refused.`); continue; }
    if (market.tokenIds[market.side] !== target.tokenId) { notes.push(`${label}: the target names a different outcome than the configured one, refused.`); continue; }
    if (blocked.has(target.id)) continue;
    if (pending.has(target.tokenId)) { notes.push(`${label}: an order is still resting.`); continue; }
    if (target.expiresAt !== null && !(input.now < Date.parse(target.expiresAt))) { notes.push(`${label}: the target has expired.`); continue; }
    if (buys >= THEME_MAX_BUYS_PER_CYCLE) { notes.push(`${label}: waiting for the next cycle (at most ${THEME_MAX_BUYS_PER_CYCLE} entries per cycle).`); continue; }
    const quote = input.quotes[target.tokenId];
    if (!quote || quote.ask <= 0) { notes.push(`${label}: no ask to buy from.`); continue; }
    if (quote.ask > target.maxPrice) { notes.push(`${label}: the ask ${quote.ask} is above the limit ${target.maxPrice}.`); continue; }
    if (input.entryRule) {
      const { minBuyPrice, minEdge } = input.entryRule;
      if (quote.ask < minBuyPrice - 1e-9) { notes.push(`${label}: the ask ${quote.ask} is under the ${minBuyPrice} floor.`); continue; }
      if (target.q === null || target.q - quote.ask < minEdge - 1e-9) { notes.push(`${label}: Q is not ${Math.round(minEdge * 100)} points above the ask ${quote.ask}.`); continue; }
    }
    if (quote.ask >= target.takeProfitPrice) { notes.push(`${label}: the ask ${quote.ask} is already at the take-profit price.`); continue; }

    const limitPx = Math.min(quote.ask, target.maxPrice);
    const headroomUsd = input.equityUsd - exposure;
    const budgetUsd = Math.floor(Math.min(perPositionUsd, collateralLeft, headroomUsd) * 100) / 100;
    const shares = floorShares(budgetUsd / limitPx);
    const minShares = quote.minShares && quote.minShares > 0 ? quote.minShares : THEME_DEFAULT_MIN_SHARES;
    if (budgetUsd < THEME_MIN_ORDER_USD || shares < minShares) {
      notes.push(`${label}: $${budgetUsd.toFixed(2)} is available for it, below the venue minimum of ${minShares} shares or $${THEME_MIN_ORDER_USD}.`);
      continue;
    }
    actions.push({ kind: "buy", targetId: target.id, conditionId: target.conditionId, tokenId: target.tokenId, outcome: target.outcome, question: target.question, limitPx, maxPrice: target.maxPrice, shares, budgetUsd });
    collateralLeft -= budgetUsd;
    exposure += budgetUsd;
    buys += 1;
  }
  return { hold: null, actions, notes, kept };
}

function pushSell(actions: ThemeAction[], notes: string[], holding: ThemeHolding, conditionId: string, quote: ThemeQuote, why: "take-profit" | "closed", reason: string): void {
  // Reduce only: never more than is held.
  const shares = floorShares(holding.size);
  const minShares = quote.minShares && quote.minShares > 0 ? quote.minShares : 0;
  if (shares <= 0 || shares < minShares) {
    notes.push(`${short(conditionId)}: ${holding.size} shares is below the venue's minimum order, left as is.`);
    return;
  }
  actions.push({ kind: "sell", conditionId, tokenId: holding.tokenId, shares, minPrice: quote.bid, why, reason });
}

const short = (conditionId: string): string => (conditionId.length > 12 ? `${conditionId.slice(0, 10)}...` : conditionId);

/** One line for the log. */
export function describeThemeDecision(decision: ThemeDecision, dryRun: boolean): string {
  if (decision.hold !== null) return `Holding. ${decision.hold}`;
  const verb = dryRun ? "Would" : "Will";
  const parts = decision.actions.map((a) =>
    a.kind === "buy" ? `${verb.toLowerCase()} buy ${a.shares} "${a.outcome}" of ${short(a.conditionId)} at up to ${a.limitPx}`
      : a.kind === "sell" ? `${verb.toLowerCase()} sell ${a.shares} of ${short(a.conditionId)} at ${a.minPrice} or better (${a.why})`
        : `${verb.toLowerCase()} redeem ${short(a.conditionId)}`);
  const head = parts.length > 0 ? `${cap(parts.join("; "))}.` : `Nothing to do. ${decision.kept} position${decision.kept === 1 ? "" : "s"} kept.`;
  return decision.notes.length > 0 ? `${head} ${decision.notes.slice(0, 4).join(" ")}` : head;
}

const cap = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
