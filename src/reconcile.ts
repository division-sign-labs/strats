// The decision function. Pure: no I/O, no clock, no package imports beyond
// types. Every cycle the runner reads the target and the venue, calls this,
// and acts on the one Decision it returns. Nothing is remembered between calls.
import type { TargetDoc } from "./protocol/index.js";

export type Side = "long" | "short";

export interface PositionView {
  side: Side;
  /** Base units (coins or contracts). */
  size: number;
  entryPx: number;
}

/** An open order on the target coin, reduced to what is needed to recognise our exits. */
export interface OrderView {
  id: string;
  side: "buy" | "sell";
  /** Unfilled size in base units. */
  remainingSize: number;
  /** Limit price. */
  price: number;
  reduceOnly: boolean;
  isTrigger: boolean;
  triggerPx?: number;
  triggerKind?: "sl" | "tp";
}

export type TargetInput = { ok: true; doc: TargetDoc } | { ok: false; reason: string };

export interface ReconcileInput {
  target: TargetInput;
  /** Epoch milliseconds. */
  now: number;
  position: PositionView | null;
  openOrders: OrderView[];
  mid: number;
  bid: number;
  ask: number;
  equityUsd: number;
  /** Position size from the server config, % of equity. */
  positionPct: number;
  /** The operator's local ceiling, % of equity. The server cannot raise it. */
  ceilingPct: number;
  instrument: { szDecimals: number; minNotional: number };
  /** Never changes the decision. It only changes how the decision is worded. */
  dryRun: boolean;
  /** A reason the runner cannot open right now (for example the account mode). Closing and repairs still run. */
  openBlockedReason?: string;
}

export type Decision =
  | { kind: "hold"; reason: string }
  | { kind: "none"; reason: string }
  | { kind: "open"; side: Side; sizeBase: number; limitPx: number; stopPx: number; targetPx: number; notionalUsd: number }
  | { kind: "close"; reason: string }
  | { kind: "repair"; placeStop?: number; placeTarget?: number; cancelOrderIds: string[] };

export const HARD_CAP_PCT = 50;
export const VENUE_MIN_NOTIONAL_USD = 10;
/** How far past the touch the entry may pay, in percent. The entry limit still binds. */
export const ENTRY_SLIPPAGE_PCT = 0.2;

export function effectivePct(positionPct: number, ceilingPct: number): number {
  return Math.min(positionPct, ceilingPct, HARD_CAP_PCT);
}

/** Round down to the venue's size step without binary-float undershoot. */
export function floorToDecimals(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Number((Math.floor(value * scale + 1e-9) / scale).toFixed(decimals));
}

/**
 * The price Hyperliquid will actually carry for an order: at most 5 significant
 * figures and at most (6 - szDecimals) decimals. Buys round down and sells round
 * up, which for an exit order means toward earlier protection. Mirrors
 * formatBoundedHlPrice in cassie-core, which the package does not export.
 */
export function venuePrice(px: number, szDecimals: number, side: "buy" | "sell"): number {
  const decimals = Math.max(0, Math.min(6 - szDecimals, 4 - Math.floor(Math.log10(px))));
  const scale = 10 ** decimals;
  const rounded = (side === "buy" ? Math.floor(px * scale) : Math.ceil(px * scale)) / scale;
  return Number(rounded.toFixed(decimals));
}

const sentence = (text: string): string => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);
const samePrice = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);

/** Null when the target may be acted on; otherwise why the runner must hold. */
export function holdReason(target: TargetInput, now: number): string | null {
  if (!target.ok) return target.reason;
  const doc = target.doc;
  if (now > Date.parse(doc.validUntil)) return `The target expired at ${doc.validUntil} and no newer one has arrived.`;
  if (doc.target.side === "flat" && doc.target.flatReason === "unavailable") return sentence(`Q has no usable reading: ${doc.target.reason}`);
  return null;
}

export function reconcile(input: ReconcileInput): Decision {
  // HOLD: a fault never opens and never closes. Exits already on the venue stay there.
  const hold = holdReason(input.target, input.now);
  if (hold !== null || !input.target.ok) return { kind: "hold", reason: hold ?? "The target is not usable." };

  const { doc } = input.target;
  const t = doc.target;
  const { position } = input;
  // Our exits are recognised by shape: a reduce-only stop trigger or a reduce-only resting limit.
  const ours = input.openOrders.filter((o) => o.reduceOnly && (!o.isTrigger || o.triggerKind === "sl"));

  if (t.side === "flat") {
    if (position) return { kind: "close", reason: t.flatReason === "expired" ? "Q's signal expired." : "Q is neutral." };
    if (ours.length > 0) return { kind: "repair", cancelOrderIds: ours.map((o) => o.id) };
    return { kind: "none", reason: t.flatReason === "expired" ? "Q's signal expired and there is no position." : "Q is neutral and there is no position." };
  }

  // parseTarget guarantees these on a directional target; hold rather than guess if they are missing.
  if (t.entryLimit === null || t.stopPx === null || t.targetPx === null) return { kind: "hold", reason: "The target has a side but no price levels." };
  const side: Side = t.side;
  const long = side === "long";
  const exitSide = long ? "sell" : "buy";
  const expired = t.expiresAt !== null && input.now >= Date.parse(t.expiresAt);

  if (position) {
    if (position.side !== side) return { kind: "close", reason: `The position is ${position.side} and Q is now ${side}.` };
    if (expired) return { kind: "close", reason: `Q's signal expired at ${t.expiresAt}.` };
    return manageExits(position, ours, t.stopPx, t.targetPx, exitSide, input);
  }

  // Flat from here on. Exits left over from a closed position are removed before anything else.
  if (ours.length > 0) return { kind: "repair", cancelOrderIds: ours.map((o) => o.id) };
  if (expired) return { kind: "none", reason: `Q's ${side} signal expired at ${t.expiresAt}. Not opening.` };
  if (doc.mode === "reduce-only") return { kind: "none", reason: `Q is ${side} but the target is reduce-only. Not opening.` };

  const pct = effectivePct(input.positionPct, input.ceilingPct);
  if (!(pct > 0) || !(input.bid > 0) || !(input.ask >= input.bid)) {
    return { kind: "none", reason: input.openBlockedReason ?? "Position size or market price is not available. Not opening." };
  }

  // Sizing: a fixed share of equity at 1x isolated leverage, priced at the most the entry may pay.
  const touch = long ? input.ask : input.bid;
  const crossing = touch * (1 + (long ? 1 : -1) * (ENTRY_SLIPPAGE_PCT / 100));
  const limitPx = venuePrice(long ? Math.min(t.entryLimit, crossing) : Math.max(t.entryLimit, crossing), input.instrument.szDecimals, long ? "buy" : "sell");
  const budgetUsd = (Math.max(0, input.equityUsd) * pct) / 100;
  const sizeBase = floorToDecimals(budgetUsd / limitPx, input.instrument.szDecimals);
  const notionalUsd = sizeBase * limitPx;
  const floorUsd = Math.max(VENUE_MIN_NOTIONAL_USD, input.instrument.minNotional);
  if (notionalUsd < floorUsd) {
    const stepUsd = limitPx * 10 ** -input.instrument.szDecimals;
    const neededEquity = Math.ceil(((floorUsd + stepUsd) * 100) / pct);
    const deposit = Math.max(1, Math.ceil(neededEquity - Math.max(0, input.equityUsd)));
    return {
      kind: "none",
      reason: `Position size is ${usd(budgetUsd)} (${pct}% of ${usd(input.equityUsd)} equity), below the ${usd(floorUsd)} minimum order. Deposit at least $${deposit} more to trade at this size.`,
    };
  }

  if (long ? input.ask > t.entryLimit : input.bid < t.entryLimit) {
    return { kind: "none", reason: `Q is ${side} but the price ${px(touch)} is ${long ? "above" : "below"} the entry limit ${px(t.entryLimit)}. Not opening.` };
  }
  if (long ? input.bid <= t.stopPx : input.ask >= t.stopPx) return { kind: "none", reason: `Q is ${side} but the price has already crossed the stop ${px(t.stopPx)}. Not opening.` };
  if (long ? input.ask >= t.targetPx : input.bid <= t.targetPx) return { kind: "none", reason: `Q is ${side} but the price has already reached the target ${px(t.targetPx)}. Not opening.` };
  if (input.openBlockedReason) return { kind: "none", reason: input.openBlockedReason };

  return { kind: "open", side, sizeBase, limitPx, stopPx: t.stopPx, targetPx: t.targetPx, notionalUsd };
}

/** With a position on the right side: make sure exactly one correct stop and one correct target rest on the venue. */
function manageExits(position: PositionView, ours: OrderView[], stopPx: number, targetPx: number, exitSide: "buy" | "sell", input: ReconcileInput): Decision {
  const { szDecimals } = input.instrument;
  const wantStop = venuePrice(stopPx, szDecimals, exitSide);
  const wantTarget = venuePrice(targetPx, szDecimals, exitSide);
  const covers = (o: OrderView): boolean => o.remainingSize >= position.size * (1 - 1e-6);

  const stops = ours.filter((o) => o.isTrigger && o.side === exitSide);
  const targets = ours.filter((o) => !o.isTrigger && o.side === exitSide);
  const goodStop = stops.find((o) => o.triggerPx !== undefined && samePrice(o.triggerPx, wantStop) && covers(o));
  const goodTarget = targets.find((o) => samePrice(o.price, wantTarget) && covers(o));

  if (!goodStop) {
    // A stop that is already through the market cannot be placed; the only protection left is to close.
    const through = exitSide === "sell" ? input.mid <= wantStop : input.mid >= wantStop;
    if (through) return { kind: "close", reason: `The price is through the stop ${px(stopPx)} and no stop order is resting.` };
  }

  const cancelOrderIds = ours.filter((o) => o !== goodStop && o !== goodTarget).map((o) => o.id);
  if (goodStop && goodTarget && cancelOrderIds.length === 0) {
    return { kind: "none", reason: `Holding ${position.side} ${position.size}. Stop ${px(wantStop)} and target ${px(wantTarget)} are in place.` };
  }
  return {
    kind: "repair",
    ...(goodStop ? {} : { placeStop: stopPx }),
    ...(goodTarget ? {} : { placeTarget: targetPx }),
    cancelOrderIds,
  };
}

export function usd(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A price with enough digits to be exact for anything the venue accepts. */
export function px(value: number): string {
  return `$${value.toLocaleString("en-US", { maximumSignificantDigits: 6 })}`;
}

/** One plain sentence (or two) for the cycle line. In a dry run, actions are worded as "Would ...". */
export function describeDecision(decision: Decision, coin: string, dryRun: boolean): string {
  switch (decision.kind) {
    case "hold":
      return `Hold. ${decision.reason} Nothing was changed.`;
    case "none":
      return `No action. ${decision.reason}`;
    case "open":
      return `${dryRun ? "Would open" : "Opening"} ${decision.side} ${decision.sizeBase} ${coin} at up to ${px(decision.limitPx)} (${usd(decision.notionalUsd)}). Stop ${px(decision.stopPx)}, target ${px(decision.targetPx)}.`;
    case "close":
      return `${dryRun ? "Would close" : "Closing"} the ${coin} position. ${decision.reason}`;
    case "repair": {
      const parts: string[] = [];
      if (decision.placeStop !== undefined) parts.push(`place a stop at ${px(decision.placeStop)}`);
      if (decision.placeTarget !== undefined) parts.push(`place a target at ${px(decision.placeTarget)}`);
      if (decision.cancelOrderIds.length > 0) parts.push(`cancel ${decision.cancelOrderIds.length} outdated exit ${decision.cancelOrderIds.length === 1 ? "order" : "orders"}`);
      return `${dryRun ? "Would" : "Will"} ${parts.join(", ")} on ${coin}.`;
    }
  }
}
