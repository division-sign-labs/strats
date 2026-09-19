// Thin wrapper over the cassie-core Hyperliquid adapter. It reads everything
// from the venue each cycle and performs the three actions the decision
// function can ask for. No state is kept between calls except the adapter's
// own short caches.
import {
  HyperliquidOrderNotSubmittedError,
  HyperliquidOrderRejectedError,
  VenueUrlsSchema,
  checkCapacity,
  createAdapter,
  type Order,
  type OrderAck,
  type PerpMarketSnapshot,
  type Position,
  type VenueAccount,
  type VenueAdapter,
} from "@quotient-forecasting/cassie-core";
import { ENTRY_SLIPPAGE_PCT, VENUE_MIN_NOTIONAL_USD, floorToDecimals, px, type Decision, type OrderView, type PositionView } from "./reconcile.js";

/** Slippage allowed once a stop triggers, percent. */
const STOP_SLIPPAGE_PCT = 2;
/** Slippage band for a reduce-only close, percent. */
const CLOSE_SLIPPAGE_PCT = 0.5;
const FILL_POLL_ATTEMPTS = 11;
const FILL_POLL_MS = 500;
const MAX_ENTRY_ATTEMPTS = 3;

type PerpMethods = "perpAccountSnapshot" | "perpMarketSnapshot" | "perpCashFlows" | "configurePerpLeverage" | "placePerpStop" | "lookupPerpOrder" | "disarmScheduledCancel" | "portfolioScope" | "runFundingFlow";
export type PerpAdapter = VenueAdapter & Required<Pick<VenueAdapter, PerpMethods>>;

export interface VenueOptions {
  coin: string;
  /** "" for the main dex, otherwise the HIP-3 dex name. */
  dex: string;
  masterAddress: string;
  agentAddress?: string;
  /** Omit for read-only use (status, dry run). Without it nothing can be signed. */
  agentPk?: string;
}

export interface VenueSnapshot {
  coin: string;
  /** Hyperliquid's name for the account mode. "disabled" is Standard mode, the only one the adapter opens positions in. */
  accountMode: string;
  standardMode: boolean;
  equityUsd: number;
  availableUsd: number;
  /** HIP-3 only: USDC still sitting in the main account, not yet moved to the dex. */
  fundingBalanceUsd: number;
  position: Position | null;
  /** Positions in other coins on the same dex. The runner never touches them and will not open while they exist. */
  otherPositions: Position[];
  /** Open orders on the target coin. */
  orders: Order[];
  market: PerpMarketSnapshot;
}

export interface ActionResult {
  /** False when the action did not complete. The next cycle re-reads the venue and converges either way. */
  ok: boolean;
  text: string;
}

export interface SignalRef {
  signalId: string | null;
  revision: number | null;
}

export function buildAdapter(dex: string, creds?: { agentPk: string; masterAddress: string }): PerpAdapter {
  // perpDex must be undefined, not "", for the main dex: the two behave differently inside the adapter.
  const adapter = createAdapter("hyperliquid", {
    urls: VenueUrlsSchema.parse({}),
    perpDex: dex || undefined,
    ...(creds ? { creds: { venue: "hyperliquid" as const, agentPk: creds.agentPk, masterAddress: creds.masterAddress } } : {}),
  });
  const needed: PerpMethods[] = ["perpAccountSnapshot", "perpMarketSnapshot", "perpCashFlows", "configurePerpLeverage", "placePerpStop", "lookupPerpOrder", "disarmScheduledCancel", "portfolioScope", "runFundingFlow"];
  for (const method of needed) {
    if (typeof adapter[method] !== "function") throw new Error(`The Hyperliquid adapter is missing ${method}.`);
  }
  return adapter as PerpAdapter;
}

export const toPositionView = (p: Position | null): PositionView | null =>
  p && (p.side === "LONG" || p.side === "SHORT") ? { side: p.side === "LONG" ? "long" : "short", size: p.size, entryPx: p.avgPrice } : null;

export const toOrderView = (o: Order): OrderView => ({
  id: o.id,
  side: o.side === "BUY" ? "buy" : "sell",
  remainingSize: o.size - o.filledSize,
  price: o.price,
  reduceOnly: o.reduceOnly === true,
  isTrigger: o.isTrigger === true,
  ...(o.triggerPrice !== undefined ? { triggerPx: o.triggerPrice } : {}),
  ...(o.triggerKind !== undefined ? { triggerKind: o.triggerKind } : {}),
});

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class Venue {
  readonly coin: string;
  readonly canSign: boolean;
  private readonly adapter: PerpAdapter;
  private readonly acct: VenueAccount;
  private scheduledCancelCleared = false;

  /** `adapter` is a test seam; production always builds the real one. */
  constructor(opts: VenueOptions, adapter?: PerpAdapter) {
    const expectedDex = opts.coin.includes(":") ? opts.coin.split(":")[0] : "";
    if (expectedDex !== opts.dex) throw new Error(`Coin "${opts.coin}" does not belong to dex "${opts.dex}".`);
    this.coin = opts.coin;
    this.canSign = opts.agentPk !== undefined;
    this.adapter = adapter ?? buildAdapter(opts.dex, opts.agentPk ? { agentPk: opts.agentPk, masterAddress: opts.masterAddress } : undefined);
    this.acct = { venue: "hyperliquid", masterAddress: opts.masterAddress, ...(opts.agentAddress ? { agentAddress: opts.agentAddress } : {}) };
  }

  /** Read-only. Every query is keyed by the master address. */
  async snapshot(): Promise<VenueSnapshot> {
    const scope = await this.adapter.portfolioScope(this.acct);
    const standardMode = scope.accountMode === "disabled";
    const market = await this.adapter.perpMarketSnapshot(this.acct, this.coin);
    if (!market.instrument.active) throw new Error(`${this.coin} is delisted on Hyperliquid.`);

    let equityUsd: number, availableUsd: number, positions: Position[], orders: Order[];
    if (standardMode) {
      // The authoritative read: it also rejects stale account state.
      const account = await this.adapter.perpAccountSnapshot(this.acct);
      ({ equity: equityUsd, availableCollateral: availableUsd, positions, openOrders: orders } = account);
    } else {
      // perpAccountSnapshot refuses any other mode. These reads still work, so an
      // unfunded or not-yet-Standard account can be shown and existing exits managed.
      const [balances, p, o] = await Promise.all([this.adapter.balances(this.acct), this.adapter.positions(this.acct), this.adapter.openOrders(this.acct)]);
      equityUsd = balances[0]?.total ?? 0;
      availableUsd = balances[0]?.available ?? 0;
      positions = p;
      orders = o;
    }
    return {
      coin: this.coin,
      accountMode: scope.accountMode,
      standardMode,
      equityUsd,
      availableUsd,
      fundingBalanceUsd: scope.fundingBalance,
      position: positions.find((p) => p.marketRef === this.coin && p.size > 0) ?? null,
      otherPositions: positions.filter((p) => p.marketRef !== this.coin && p.size > 0),
      orders: orders.filter((o) => o.marketRef === this.coin),
      market,
    };
  }

  /** Net deposits into this dex since `sinceTs`. `complete: false` means the number is not authoritative. */
  async netDeposits(sinceTs: number): Promise<{ amountUsd: number; complete: boolean }> {
    const result = await this.adapter.perpCashFlows(this.acct, sinceTs);
    return { amountUsd: result.flows.reduce((sum, flow) => sum + flow.amount, 0), complete: result.complete };
  }

  /**
   * Reference sequence: isolated 1x leverage, IOC entry under a deterministic
   * client id, wait until the position is visible, then a stop sized to the
   * actual position, then the reduce-only target.
   */
  async openPosition(decision: Extract<Decision, { kind: "open" }>, snap: VenueSnapshot, signal: SignalRef): Promise<ActionResult> {
    const long = decision.side === "long";

    // One entry per signal revision. The client id is derived from the signal, so the venue itself
    // remembers whether this revision was already traded, across restarts and without local state.
    let clientId: string | undefined;
    try {
      for (let attempt = 0; attempt < MAX_ENTRY_ATTEMPTS && !clientId; attempt++) {
        const candidate = `strats:${this.coin}:${signal.signalId ?? "none"}:${signal.revision ?? 0}:entry:${attempt}`;
        const seen = await this.adapter.lookupPerpOrder(this.acct, candidate);
        if (!seen.found) clientId = candidate;
        else if ((seen.ack.filledSize ?? 0) > 0) return { ok: true, text: "This signal revision was already entered once and that position has closed. Not opening again until Q publishes a new revision." };
      }
      if (!clientId) return { ok: true, text: `${MAX_ENTRY_ATTEMPTS} entry orders for this signal revision went unfilled. Not trying again until Q publishes a new revision.` };

      // Never call heartbeat, and make sure no earlier process left a scheduled cancel armed: when it fires it removes stops too.
      if (!this.scheduledCancelCleared) {
        await this.adapter.disarmScheduledCancel(this.acct);
        this.scheduledCancelCleared = true;
      }
      await this.adapter.configurePerpLeverage(this.acct, { marketRef: this.coin, leverage: 1, marginMode: "isolated" });
    } catch (error) {
      return { ok: false, text: `Not opening: ${message(error)}. No order was sent.` };
    }

    const floorUsd = Math.max(VENUE_MIN_NOTIONAL_USD, snap.market.instrument.minNotional);
    const capacity = checkCapacity({
      side: long ? "BUY" : "SELL",
      desiredSize: decision.sizeBase,
      refPrice: decision.limitPx,
      book: snap.market.book,
      quote: snap.market.quote,
      risk: { slippagePct: ENTRY_SLIPPAGE_PCT, depthCapPct: 100, minDailyVolume: 100_000, minViableNotional: floorUsd, maxOrderNotional: decision.notionalUsd, orderTtlSec: 900 },
    });
    if (!capacity.ok) return { ok: true, text: `Not opening: ${capacity.skipReasons.join("; ")}.` };
    const size = floorToDecimals(Math.min(capacity.size, decision.sizeBase), snap.market.instrument.szDecimals);
    if (size * decision.limitPx < floorUsd) return { ok: true, text: "Not opening: the book is too thin to fill the minimum order inside the slippage band." };

    let ack: OrderAck;
    try {
      ack = await this.adapter.placeOrder(this.acct, {
        marketRef: this.coin, side: long ? "BUY" : "SELL", size, limitPrice: decision.limitPx,
        tif: "IOC", postOnly: false, reduceOnly: false, purpose: "entry", clientId,
      });
    } catch (error) {
      // Subclass first: a rejection is also a not-submitted error.
      if (error instanceof HyperliquidOrderRejectedError) return { ok: false, text: `Hyperliquid rejected the entry order: ${error.message}. Not retrying this cycle.` };
      if (error instanceof HyperliquidOrderNotSubmittedError) return { ok: false, text: "The entry order was not submitted (a venue read was deferred). It is safe to retry next cycle." };
      return { ok: false, text: `The entry order may or may not have reached Hyperliquid (${message(error)}). Not resending; the next cycle reads the venue and continues from there.` };
    }

    // The fill acknowledgement is not a position. Wait until the venue shows one before sizing the stop.
    let position: Position | undefined;
    const attempts = (ack.filledSize ?? 0) > 0 || ack.status === "filled" ? FILL_POLL_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts && !position; attempt++) {
      if (attempt > 0) await sleep(FILL_POLL_MS);
      const positions = await this.adapter.positions(this.acct).catch(() => [] as Position[]);
      position = positions.find((p) => p.marketRef === this.coin && p.side === (long ? "LONG" : "SHORT") && p.size > 0);
    }
    if (!position) {
      return (ack.filledSize ?? 0) > 0
        ? { ok: false, text: "The entry filled but the position is not visible yet. The next cycle places the stop and target." }
        : { ok: true, text: `The entry order at up to ${px(decision.limitPx)} did not fill. The next cycle tries again if the price still allows it.` };
    }

    const stop = await this.placeStop(position, decision.stopPx);
    const target = await this.placeTarget(position, decision.targetPx);
    const opened = `Opened ${decision.side} ${position.size} ${this.coin} at ${px(position.avgPrice)}.`;
    if (stop.ok && target.ok) return { ok: true, text: `${opened} Stop ${px(decision.stopPx)} and target ${px(decision.targetPx)} are placed.` };
    return { ok: false, text: `${opened} ${stop.ok ? "" : `${stop.text} `}${target.ok ? "" : `${target.text} `}The next cycle retries.` };
  }

  /**
   * Cancel our target by id and confirm it is gone, send a reduce-only IOC close,
   * then cancel our stop by id once the position is flat. The stop stays on the
   * venue until then so a partial close is never left unprotected. Never cancelAll.
   */
  async closePosition(snap: VenueSnapshot): Promise<ActionResult> {
    const position = snap.position;
    if (!position) return { ok: true, text: `There is no ${this.coin} position to close.` };
    const exitSide = position.side === "LONG" ? "SELL" : "BUY";
    const ours = snap.orders.filter((o) => o.reduceOnly === true && o.side === exitSide);
    const targets = ours.filter((o) => o.isTrigger !== true);
    const stops = ours.filter((o) => o.isTrigger === true && o.triggerKind === "sl");

    // Two reduce-only orders must not compete for one position. cancelOrder is silent, so confirm by reading.
    if (targets.length > 0) {
      for (const order of targets) await this.adapter.cancelOrder(this.acct, order.id);
      const still = (await this.adapter.openOrders(this.acct)).filter((o) => targets.some((t) => t.id === o.id));
      if (still.length > 0) return { ok: false, text: "The target order could not be cancelled, so the close was not sent. The stop stays in place." };
    }

    const [book, quote] = await Promise.all([this.adapter.book(this.coin), this.adapter.quote(this.coin)]);
    const capacity = checkCapacity({
      side: exitSide, desiredSize: position.size, refPrice: quote.mid, book, quote,
      risk: { slippagePct: CLOSE_SLIPPAGE_PCT, depthCapPct: 100, minDailyVolume: 0, minViableNotional: 0, maxOrderNotional: Number.MAX_SAFE_INTEGER, orderTtlSec: 300 },
      // An exit is never blocked by the entry minimum.
      enforceMinimumNotional: false,
    });
    if (!capacity.ok) return { ok: false, text: `The close was not sent: ${capacity.skipReasons.join("; ")}. The stop stays in place.` };

    try {
      await this.adapter.placeOrder(this.acct, {
        marketRef: this.coin, side: exitSide, size: capacity.size, limitPrice: capacity.limitPrice,
        tif: "IOC", postOnly: false, reduceOnly: true, purpose: "normal-exit", clientId: `strats:${this.coin}:close:${Date.now()}`,
      });
    } catch (error) {
      if (error instanceof HyperliquidOrderRejectedError) return { ok: false, text: `Hyperliquid rejected the close order: ${error.message}. The stop stays in place.` };
      if (error instanceof HyperliquidOrderNotSubmittedError) return { ok: false, text: "The close order was not submitted (a venue read was deferred). It is safe to retry next cycle. The stop stays in place." };
      return { ok: false, text: `The close order may or may not have reached Hyperliquid (${message(error)}). It is reduce-only, so it cannot open a new position. The next cycle reads the venue again.` };
    }

    let remaining: Position | undefined = position;
    for (let attempt = 0; attempt < FILL_POLL_ATTEMPTS && remaining; attempt++) {
      if (attempt > 0) await sleep(FILL_POLL_MS);
      const positions = await this.adapter.positions(this.acct).catch(() => undefined);
      if (positions) remaining = positions.find((p) => p.marketRef === this.coin && p.size > 0);
    }
    if (remaining) return { ok: false, text: `Closed part of the ${this.coin} position; ${remaining.size} remains and the stop stays in place. The next cycle continues.` };

    for (const order of stops) await this.adapter.cancelOrder(this.acct, order.id).catch(() => undefined);
    return { ok: true, text: `Closed the ${this.coin} position of ${position.size}.` };
  }

  /**
   * Restore the exits. A new stop is placed before an outdated one is cancelled,
   * so the position is never without protection. An outdated target is cancelled
   * before its replacement, so two targets never compete.
   */
  async repair(decision: Extract<Decision, { kind: "repair" }>, snap: VenueSnapshot): Promise<ActionResult> {
    const doomed = snap.orders.filter((o) => decision.cancelOrderIds.includes(o.id));
    const done: string[] = [];
    const failed: string[] = [];
    const cancel = async (orders: Order[]): Promise<void> => {
      for (const order of orders) {
        try {
          await this.adapter.cancelOrder(this.acct, order.id);
          done.push(`cancelled order ${order.id}`);
        } catch (error) {
          failed.push(`could not cancel order ${order.id} (${message(error)})`);
        }
      }
    };

    let stopOk = true;
    if (decision.placeStop !== undefined && snap.position) {
      const stop = await this.placeStop(snap.position, decision.placeStop);
      stopOk = stop.ok;
      (stop.ok ? done : failed).push(stop.text);
    }
    // Keep an outdated stop if its replacement failed: some protection is better than none.
    await cancel(doomed.filter((o) => o.isTrigger !== true || stopOk));
    if (decision.placeTarget !== undefined && snap.position) {
      const target = await this.placeTarget(snap.position, decision.placeTarget);
      (target.ok ? done : failed).push(target.text);
    }
    const text = [...done, ...failed].join("; ");
    return { ok: failed.length === 0, text: `${text.charAt(0).toUpperCase()}${text.slice(1)}.` };
  }

  private async placeStop(position: Position, stopPx: number): Promise<ActionResult> {
    try {
      const ack = await this.adapter.placePerpStop(this.acct, {
        marketRef: this.coin, positionSide: position.side === "LONG" ? "LONG" : "SHORT", size: position.size,
        stopPx, slippagePct: STOP_SLIPPAGE_PCT, clientId: `strats:${this.coin}:stop:${Date.now()}`,
      });
      if (ack.status === "rejected") return { ok: false, text: `the stop at ${px(stopPx)} was rejected by Hyperliquid` };
      return { ok: true, text: `placed a stop at ${px(stopPx)}` };
    } catch (error) {
      return { ok: false, text: `the stop at ${px(stopPx)} could not be placed (${message(error)})` };
    }
  }

  private async placeTarget(position: Position, targetPx: number): Promise<ActionResult> {
    try {
      await this.adapter.placeOrder(this.acct, {
        marketRef: this.coin, side: position.side === "LONG" ? "SELL" : "BUY", size: position.size, limitPrice: targetPx,
        tif: "GTC", postOnly: false, reduceOnly: true, purpose: "target", clientId: `strats:${this.coin}:target:${Date.now()}`,
      });
      return { ok: true, text: `placed a target at ${px(targetPx)}` };
    } catch (error) {
      return { ok: false, text: `the target at ${px(targetPx)} could not be placed (${message(error)})` };
    }
  }
}
