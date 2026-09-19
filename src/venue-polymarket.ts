// Thin wrapper over the cassie-core Polymarket adapter. It reads the wallet and
// the books fresh each cycle and performs the three actions the theme decision
// function can ask for: buy, sell, redeem. This is the only file that places
// Polymarket orders. It never calls cancelAll and never sells more than is held.
import {
  PolymarketOrderRejectedError,
  VenueUrlsSchema,
  checkCapacity,
  createAdapter,
  outcomeTokensOf,
  type Order,
  type OrderBook,
  type Position,
  type Quote,
  type VenueAccount,
  type VenueAdapter,
} from "@quotient-forecasting/cassie-core";
import type { ThemeMarket } from "./protocol/index.js";
import { THEME_MIN_ORDER_USD, floorShares, type ThemeAction, type ThemeHolding, type ThemeQuote } from "./reconcile-theme.js";
import type { PolymarketCreds } from "./runtime-creds.js";

/** How far past the touch a buy may reach, percent. The target's maxPrice still caps it. */
const BUY_SLIPPAGE_PCT = 2;
const BOOK_CONCURRENCY = 4;
const GEOBLOCK_URL = "https://polymarket.com/api/geoblock";

type PmMethods = "tokenBook" | "tokenBalance" | "redeem" | "runFundingFlow";
export type PmAdapter = VenueAdapter & Required<Pick<VenueAdapter, PmMethods>>;

export interface PolymarketAccount {
  signerAddress: string;
  funder: string;
  signatureType: number;
}

export interface PolymarketSnapshot {
  collateralUsd: number;
  exposureUsd: number;
  equityUsd: number;
  /** Every holding the venue reports, plus configured tokens found by a direct balance read. */
  holdings: Array<ThemeHolding & { avgPrice: number; valueUsd: number; label?: string }>;
  quotes: Record<string, ThemeQuote>;
  /** Books kept for the capacity check of a buy. */
  books: Record<string, OrderBook>;
  pendingTokenIds: string[];
  orders: Order[];
}

export interface PmActionResult {
  ok: boolean;
  text: string;
  /** Notional that traded, USD. */
  filledUsd: number;
  /** True when an order went out and its result is unknown. The caller must not send another for a while. */
  uncertain?: boolean;
}

export function buildPolymarketAdapter(creds?: PolymarketCreds): PmAdapter {
  const adapter = createAdapter("polymarket", { urls: VenueUrlsSchema.parse({}), ...(creds ? { creds } : {}) });
  for (const method of ["tokenBook", "tokenBalance", "redeem", "runFundingFlow"] as PmMethods[]) {
    if (typeof adapter[method] !== "function") throw new Error(`The Polymarket adapter is missing ${method}.`);
  }
  return adapter as PmAdapter;
}

/** One cheap public request. `null` means the answer could not be read. */
export async function polymarketGeoblock(fetchImpl: typeof fetch = fetch): Promise<{ blocked: boolean; country: string } | null> {
  try {
    const response = await fetchImpl(GEOBLOCK_URL, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { blocked?: unknown; country?: unknown };
    if (typeof body.blocked !== "boolean") return null;
    return { blocked: body.blocked, country: typeof body.country === "string" ? body.country : "this location" };
  } catch {
    return null;
  }
}

/** The adapter addresses a market by its YES token. For markets labelled with names, that is the first outcome. */
export function orderIdentity(market: ThemeMarket, tokenId: string): { marketRef: string; outcome: "YES" | "NO" } {
  const sides = outcomeTokensOf([
    { tokenId: market.tokenIds[0], outcome: market.outcomes[0] },
    { tokenId: market.tokenIds[1], outcome: market.outcomes[1] },
  ]);
  if (tokenId !== sides.yes && tokenId !== sides.no) throw new Error("The token does not belong to the configured market.");
  return { marketRef: sides.yes, outcome: tokenId === sides.yes ? "YES" : "NO" };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  }));
  return out;
}

export function quoteOfBook(book: OrderBook): Quote {
  const bid = book.bids[0]?.price ?? 0;
  const ask = book.asks[0]?.price ?? 0;
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
  return { marketRef: book.marketRef, bid, ask, mid, volume24h: 0, spreadBps: mid > 0 && bid > 0 && ask > 0 ? ((ask - bid) / mid) * 10_000 : 0, ts: book.ts };
}

export class PolymarketVenue {
  readonly canSign: boolean;
  private readonly adapter: PmAdapter;
  private readonly acct: VenueAccount;

  /** `readOnly` refuses every order, for status and dry runs. `adapter` is a test seam. */
  constructor(account: PolymarketAccount, creds: PolymarketCreds, opts: { readOnly?: boolean } = {}, adapter?: PmAdapter) {
    this.canSign = opts.readOnly !== true;
    this.adapter = adapter ?? buildPolymarketAdapter(creds);
    this.acct = { venue: "polymarket", signerAddress: account.signerAddress, funder: account.funder, signatureType: account.signatureType };
  }

  /**
   * `markets` are the configured markets; `quoteTokenIds` are the tokens the
   * targets name. Holdings come from the venue's position list, and configured
   * tokens it does not list (markets labelled with names rather than Yes and
   * No) are found with a direct balance read.
   */
  async snapshot(markets: ThemeMarket[], quoteTokenIds: string[]): Promise<PolymarketSnapshot> {
    const [balances, positions, orders] = await Promise.all([this.adapter.balances(this.acct), this.adapter.positions(this.acct), this.adapter.openOrders(this.acct)]);
    const collateralUsd = balances[0]?.available ?? 0;
    const byToken = new Map<string, Position>();
    for (const p of positions) if (p.tokenId && p.size > 0) byToken.set(p.tokenId, p);

    const named = markets.filter((m) => !(m.outcomes.some((o) => o.trim().toLowerCase() === "yes") && m.outcomes.some((o) => o.trim().toLowerCase() === "no")));
    const directReads = named.flatMap((m) => m.tokenIds.filter((t) => !byToken.has(t)).map((tokenId) => ({ tokenId, conditionId: m.conditionId })));
    const direct = await mapLimited(directReads, BOOK_CONCURRENCY, async (item) => ({ ...item, size: await this.adapter.tokenBalance(this.acct, item.tokenId) }));

    const wanted = [...new Set([...quoteTokenIds, ...byToken.keys(), ...direct.filter((d) => d.size > 0).map((d) => d.tokenId)])];
    const configuredTokens = new Set(markets.flatMap((m) => m.tokenIds));
    const books: Record<string, OrderBook> = {};
    const quotes: Record<string, ThemeQuote> = {};
    await mapLimited(wanted.filter((t) => configuredTokens.has(t) || quoteTokenIds.includes(t)), BOOK_CONCURRENCY, async (tokenId) => {
      try {
        const book = await this.adapter.tokenBook(tokenId);
        books[tokenId] = book;
        quotes[tokenId] = { bid: book.bids[0]?.price ?? 0, ask: book.asks[0]?.price ?? 0 };
      } catch {
        // A resolved market has no book. Without a quote the token is neither bought nor sold.
      }
    });

    const holdings: PolymarketSnapshot["holdings"] = [];
    for (const p of byToken.values()) {
      const price = p.currentPrice ?? quotes[p.tokenId!]?.bid ?? p.avgPrice;
      holdings.push({ tokenId: p.tokenId!, conditionId: p.conditionId ?? "", size: p.size, redeemable: p.redeemable === true, avgPrice: p.avgPrice, valueUsd: p.size * price, ...(p.label ? { label: p.label } : {}) });
    }
    for (const d of direct) {
      if (d.size <= 0) continue;
      holdings.push({ tokenId: d.tokenId, conditionId: d.conditionId, size: d.size, redeemable: false, avgPrice: 0, valueUsd: d.size * (quotes[d.tokenId]?.bid ?? 0) });
    }
    const exposureUsd = holdings.reduce((sum, h) => sum + h.valueUsd, 0);
    const pendingTokenIds = orders.filter((o) => o.tokenId && o.size - o.filledSize > 0).map((o) => o.tokenId!);
    return { collateralUsd, exposureUsd, equityUsd: collateralUsd + exposureUsd, holdings, quotes, books, pendingTokenIds, orders };
  }

  /** Cumulative notional of confirmed fills since `sinceTs`. */
  async volumeSince(sinceTs: number): Promise<number> {
    const fills = await this.adapter.fills(this.acct, sinceTs);
    return fills.reduce((sum, f) => sum + f.size * f.price, 0);
  }

  /**
   * A marketable fill-and-kill buy. The limit is the lower of the capacity
   * check's price and the target's maxPrice, so it never pays above maxPrice,
   * and what does not fill at once is cancelled by the venue.
   */
  async buy(action: Extract<ThemeAction, { kind: "buy" }>, market: ThemeMarket, snap: PolymarketSnapshot): Promise<PmActionResult> {
    if (!this.canSign) return { ok: false, text: "Read-only: no order was sent.", filledUsd: 0 };
    const book = snap.books[action.tokenId];
    if (!book) return { ok: true, text: `Not buying ${action.outcome}: the book could not be read.`, filledUsd: 0 };

    // The position list can lag a fill. The token balance is authoritative, so check it before every entry.
    try {
      const already = await this.adapter.tokenBalance(this.acct, action.tokenId, { refresh: true });
      if (already > 0) return { ok: true, text: `Not buying ${action.outcome}: the wallet already holds ${already} shares.`, filledUsd: 0 };
    } catch (error) {
      return { ok: false, text: `Not buying ${action.outcome}: the holding could not be confirmed (${message(error)}). No order was sent.`, filledUsd: 0 };
    }

    const capacity = checkCapacity({
      side: "BUY", desiredSize: action.shares, refPrice: action.limitPx, book, quote: quoteOfBook(book),
      risk: { slippagePct: BUY_SLIPPAGE_PCT, depthCapPct: 100, minDailyVolume: 0, minViableNotional: THEME_MIN_ORDER_USD, maxOrderNotional: action.budgetUsd, orderTtlSec: 60 },
    });
    if (!capacity.ok) return { ok: true, text: `Not buying ${action.outcome}: ${capacity.skipReasons.join("; ")}.`, filledUsd: 0 };
    const limitPrice = Math.min(capacity.limitPrice, action.maxPrice);
    const size = floorShares(Math.min(capacity.size, action.shares, action.budgetUsd / limitPrice));
    if (size <= 0) return { ok: true, text: `Not buying ${action.outcome}: the size rounds to zero.`, filledUsd: 0 };

    let identity: { marketRef: string; outcome: "YES" | "NO" };
    try {
      identity = orderIdentity(market, action.tokenId);
    } catch (error) {
      return { ok: true, text: `Not buying ${action.outcome}: ${message(error)}`, filledUsd: 0 };
    }
    try {
      const ack = await this.adapter.placeOrder(this.acct, {
        marketRef: identity.marketRef, tokenId: action.tokenId, conditionId: action.conditionId, outcome: identity.outcome,
        side: "BUY", size, limitPrice, tif: "FAK", postOnly: false, purpose: "entry", clientId: `strats:theme:${action.targetId}`,
      });
      const filled = ack.filledSize ?? 0;
      this.adapter.invalidateTokenBalance?.(action.tokenId);
      if (filled <= 0) return { ok: true, text: `The buy of ${action.outcome} at up to ${limitPrice} did not fill. The next cycle tries again if the price still allows it.`, filledUsd: 0 };
      const paid = ack.avgFillPrice ?? limitPrice;
      return { ok: true, text: `Bought ${filled} "${action.outcome}" at ${paid.toFixed(3)} ($${(filled * paid).toFixed(2)}). ${action.question}`, filledUsd: filled * paid };
    } catch (error) {
      if (error instanceof PolymarketOrderRejectedError) return { ok: false, text: `Polymarket rejected the buy of ${action.outcome}: ${error.message}. Nothing was bought.`, filledUsd: 0 };
      if (/below the current Polymarket minimum|rounds to zero|does not belong|does not match|identity changed/.test(message(error))) {
        return { ok: true, text: `Not buying ${action.outcome}: ${message(error)}. No order was sent.`, filledUsd: 0 };
      }
      return { ok: false, uncertain: true, text: `The buy of ${action.outcome} may or may not have reached Polymarket (${message(error)}). Not resending; this market is skipped for 15 minutes.`, filledUsd: 0 };
    }
  }

  /** Fill-and-kill sell at the bid or better, sized to what the wallet actually holds. */
  async sell(action: Extract<ThemeAction, { kind: "sell" }>, market: ThemeMarket | undefined): Promise<PmActionResult> {
    if (!this.canSign) return { ok: false, text: "Read-only: no order was sent.", filledUsd: 0 };
    if (!market) return { ok: true, text: `Not selling ${action.tokenId.slice(0, 10)}...: it is not one of the configured markets.`, filledUsd: 0 };
    let held: number;
    try {
      held = await this.adapter.tokenBalance(this.acct, action.tokenId, { refresh: true });
    } catch (error) {
      return { ok: false, text: `The sell was not sent: the holding could not be confirmed (${message(error)}).`, filledUsd: 0 };
    }
    const size = floorShares(Math.min(held, action.shares));
    if (size <= 0) return { ok: true, text: "Nothing left to sell.", filledUsd: 0 };
    try {
      const identity = orderIdentity(market, action.tokenId);
      const ack = await this.adapter.placeOrder(this.acct, {
        marketRef: identity.marketRef, tokenId: action.tokenId, conditionId: action.conditionId, outcome: identity.outcome,
        side: "SELL", size, limitPrice: action.minPrice, tif: "FAK", postOnly: false, purpose: "normal-exit", clientId: `strats:theme:${action.conditionId}:exit:${Date.now()}`,
      });
      const filled = ack.filledSize ?? 0;
      this.adapter.invalidateTokenBalance?.(action.tokenId);
      if (filled <= 0) return { ok: true, text: `The sell of ${size} at ${action.minPrice} did not fill. The next cycle tries again.`, filledUsd: 0 };
      const got = ack.avgFillPrice ?? action.minPrice;
      return { ok: true, text: `Sold ${filled} at ${got.toFixed(3)} ($${(filled * got).toFixed(2)}, ${action.why}). ${action.reason}`, filledUsd: filled * got };
    } catch (error) {
      if (error instanceof PolymarketOrderRejectedError) return { ok: false, text: `Polymarket rejected the sell: ${error.message}.`, filledUsd: 0 };
      return { ok: false, text: `The sell may or may not have reached Polymarket (${message(error)}). It can only reduce the position. The next cycle reads the wallet again.`, filledUsd: 0 };
    }
  }

  /** One submission per market, ever. The caller records it before this returns control to the loop. */
  async redeem(action: Extract<ThemeAction, { kind: "redeem" }>, market: ThemeMarket | undefined, snap: PolymarketSnapshot): Promise<PmActionResult> {
    if (!this.canSign) return { ok: false, text: "Read-only: nothing was redeemed.", filledUsd: 0 };
    if (!market) return { ok: true, text: "Not redeeming: it is not one of the configured markets.", filledUsd: 0 };
    const holding = snap.holdings.find((h) => h.tokenId === action.tokenId);
    if (!holding) return { ok: true, text: "Nothing to redeem.", filledUsd: 0 };
    try {
      const identity = orderIdentity(market, action.tokenId);
      const receipt = await this.adapter.redeem(this.acct, { marketRef: identity.marketRef, tokenId: action.tokenId, conditionId: action.conditionId, outcome: identity.outcome, side: identity.outcome, size: holding.size, avgPrice: holding.avgPrice, redeemable: true });
      return { ok: true, text: `Redeemed the resolved market ${action.conditionId.slice(0, 10)}...${receipt?.transactionHash ? ` (transaction ${receipt.transactionHash})` : ""}.`, filledUsd: 0 };
    } catch (error) {
      return { ok: false, uncertain: true, text: `The redemption may or may not have been accepted (${message(error)}). It is not sent again; check the wallet on Polymarket.`, filledUsd: 0 };
    }
  }
}
