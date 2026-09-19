// The display-only report. At most one every five minutes, plus one soon after
// an order is acknowledged; never in a dry run, never when --no-report is given.
// A failure costs one log line and nothing else. It carries totals, what the bot
// holds and the runner's last trades, in plain words. It never carries a key,
// and it carries the wallet address only when the creator chose to publish it.
import { postReport, type GatewayOptions } from "./client.js";
import {
  REPORT_LABEL_MAX, REPORT_MAX_POSITIONS, REPORT_MAX_TRADES, ReportPositionSchema, ReportTradeSchema,
  type Report, type ReportPosition, type ReportTrade, type StrategyId, type ThemeMarket,
} from "./protocol/index.js";
import { loadRuntimeState, saveRuntimeState } from "./runtime-state.js";
import type { BotState } from "./state.js";

export const REPORT_INTERVAL_MS = 5 * 60_000;
/** After an acknowledged order one report may go out early, but never closer than this to the one before. */
export const PROMPT_REPORT_INTERVAL_MS = 30_000;

const SECRET_SHAPES = /0x[0-9a-fA-F]{40,}|qsk_[A-Za-z0-9_-]+/g;

/** Addresses, transaction hashes and API keys never travel in the report, even inside a sentence. */
export function sanitizeAction(text: string): string {
  return text.replace(/0x[0-9a-fA-F]{40,}/g, "[address]").replace(/qsk_[A-Za-z0-9_-]+/g, "[key]").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** A label is plain words, at most 80 characters, with nothing shaped like an address, a hash or a key. */
export function sanitizeLabel(text: string, fallback: string): string {
  const clean = (value: string): string => value.replace(SECRET_SHAPES, "").replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim().slice(0, REPORT_LABEL_MAX).trim();
  return clean(text) || clean(fallback) || "Position";
}

/** `side` and `action` are short tags: letters, digits, space, period, apostrophe and hyphen, at most 12 characters. */
export function shortWord(text: string, fallback: string): string {
  const clean = text.replace(/[^A-Za-z0-9 .'-]/g, "").replace(/\s+/g, " ").trim().slice(0, 12).trim();
  return clean || fallback;
}

/** Plain names for the assets TokenStrats offers. Anything else is shown by its ticker. */
const ASSET_NAMES: Readonly<Record<string, string>> = {
  "commodity:wti": "WTI crude oil",
  "commodity:gold": "Gold",
  "commodity:silver": "Silver",
  "commodity:copper": "Copper",
  "commodity:natural-gas": "Natural gas",
  "commodity:platinum": "Platinum",
  "crypto:btc": "Bitcoin",
  "crypto:eth": "Ethereum",
  "company:nvda": "NVIDIA",
  "company:intc": "Intel",
  "company:meta": "Meta",
  "company:tsla": "Tesla",
  "company:aapl": "Apple",
  "company:orcl": "Oracle",
  "company:hood": "Robinhood",
  "company:pltr": "Palantir",
};

/** The asset's plain name: the one the server sent, a known name, or the coin's ticker. */
export function assetLabel(asset: { assetKey?: string | undefined; name?: string | undefined; coin: string }): string {
  const ticker = (asset.coin.split(":").pop() ?? asset.coin).toUpperCase();
  return sanitizeLabel(asset.name || ASSET_NAMES[(asset.assetKey ?? "").toLowerCase()] || ticker, ticker);
}

const cents = (value: number): number => Math.round(value * 100) / 100;
const finiteOrNull = (value: number | null | undefined): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
/** Prices keep their precision: a prediction-market price lives between 0 and 1. */
const priceOrNull = (value: number | null | undefined): number | null => {
  const finite = finiteOrNull(value);
  return finite === null ? null : Number(finite.toPrecision(8));
};

export interface PositionInput {
  label: string;
  venue: ReportPosition["venue"];
  side: string;
  sizeUsd: number;
  entryPrice?: number | null | undefined;
  markPrice?: number | null | undefined;
  pnlUsd?: number | null | undefined;
}

/** One row for the report, or null when it cannot be shown truthfully. Unknown prices and profit become null. */
export function toReportPosition(input: PositionInput): ReportPosition | null {
  const pnl = finiteOrNull(input.pnlUsd);
  const parsed = ReportPositionSchema.safeParse({
    label: sanitizeLabel(input.label, "Position"),
    venue: input.venue,
    side: shortWord(input.side, "held"),
    sizeUsd: cents(Math.abs(input.sizeUsd)),
    entryPrice: priceOrNull(input.entryPrice),
    markPrice: priceOrNull(input.markPrice),
    pnlUsd: pnl === null ? null : cents(pnl),
  });
  return parsed.success ? parsed.data : null;
}

export interface TradeInput {
  at: number;
  label: string;
  action: "open" | "close" | "buy" | "sell" | "redeem";
  sizeUsd: number;
  price?: number | null | undefined;
}

/** One trade for the ring, or null when it is not a valid row. A row that fails is left out rather than stored. */
export function toReportTrade(input: TradeInput): ReportTrade | null {
  if (!Number.isFinite(input.at)) return null;
  const parsed = ReportTradeSchema.safeParse({
    at: new Date(input.at).toISOString(),
    label: sanitizeLabel(input.label, "Trade"),
    action: input.action,
    sizeUsd: cents(Math.abs(input.sizeUsd)),
    price: priceOrNull(input.price),
  });
  return parsed.success ? parsed.data : null;
}

/** A single-asset bot holds at most one position. Everything comes from the snapshot the cycle already has. */
export function hyperliquidPositions(
  position: { side: string; size: number; avgPrice: number; unrealizedPnl?: number | undefined } | null,
  mid: number,
  label: string,
): ReportPosition[] {
  if (!position || !(position.size > 0)) return [];
  const mark = mid > 0 ? mid : null;
  const row = toReportPosition({
    label, venue: "hyperliquid",
    side: position.side === "SHORT" ? "short" : "long",
    sizeUsd: position.size * (mark ?? position.avgPrice),
    entryPrice: position.avgPrice > 0 ? position.avgPrice : null,
    markPrice: mark,
    pnlUsd: position.unrealizedPnl,
  });
  return row ? [row] : [];
}

/** A theme bot's holdings in its configured markets, largest first. A holding found by a direct balance read has no entry price. */
export function polymarketPositions(
  holdings: ReadonlyArray<{ tokenId: string; size: number; avgPrice: number; valueUsd: number }>,
  markets: ReadonlyArray<ThemeMarket>,
): ReportPosition[] {
  const rows: ReportPosition[] = [];
  for (const holding of [...holdings].sort((a, b) => b.valueUsd - a.valueUsd)) {
    const market = markets.find((m) => m.tokenIds.includes(holding.tokenId));
    if (!market || !(holding.size > 0)) continue;
    const outcome = market.outcomes[market.tokenIds.indexOf(holding.tokenId)] ?? "";
    const entry = holding.avgPrice > 0 ? holding.avgPrice : null;
    const mark = holding.valueUsd > 0 ? holding.valueUsd / holding.size : null;
    const row = toReportPosition({
      label: market.question || "Polymarket market", venue: "polymarket",
      side: shortWord(outcome, "outcome"),
      sizeUsd: holding.valueUsd,
      entryPrice: entry,
      markPrice: mark,
      pnlUsd: entry !== null && mark !== null ? (mark - entry) * holding.size : null,
    });
    if (row) rows.push(row);
  }
  return rows.slice(0, REPORT_MAX_POSITIONS);
}

/** The address a public portfolio page can read, and only when the creator chose to publish it. */
export function publishedWalletAddress(bot: Pick<BotState, "publishWallet" | "strategyId" | "masterAddress" | "polymarket">): string | undefined {
  if (bot.publishWallet !== true) return undefined;
  return bot.strategyId === "theme" ? bot.polymarket?.funder : bot.masterAddress;
}

export interface ReportFigures {
  venue: Report["venue"];
  equityUsd: number;
  netDepositsUsd: number;
  volumeUsd: number;
  openPositions: number;
  /** What the bot holds, already in report form. Left out when the caller has none to give. */
  positions?: ReportPosition[];
  /** The runner's last trades, newest first. */
  trades?: ReportTrade[];
  /** Pass it only when the creator opted in. See publishedWalletAddress. */
  walletAddress?: string | undefined;
}

export function buildReport(figures: ReportFigures, lastAction: string, now: number): Report {
  return {
    v: 1,
    at: new Date(now).toISOString(),
    venue: figures.venue,
    equityUsd: cents(figures.equityUsd),
    netDepositsUsd: cents(figures.netDepositsUsd),
    profitUsd: cents(figures.equityUsd - figures.netDepositsUsd),
    volumeUsd: cents(Math.max(0, figures.volumeUsd)),
    // The buyback is not implemented in this release, so nothing has been bought back.
    boughtBackUsd: 0,
    openPositions: Math.max(0, Math.trunc(figures.openPositions)),
    lastAction: sanitizeAction(lastAction),
    ...(figures.positions ? { positions: figures.positions.slice(0, REPORT_MAX_POSITIONS) } : {}),
    ...(figures.trades ? { trades: [...figures.trades].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, REPORT_MAX_TRADES) } : {}),
    ...(figures.walletAddress ? { walletAddress: figures.walletAddress } : {}),
  };
}

/** The ten totals alone, for a gateway that has not yet learned the newer fields. */
export function totalsOnly(report: Report): Report {
  const { positions: _positions, trades: _trades, walletAddress: _walletAddress, ...totals } = report;
  return totals;
}

export class Reporter {
  private lastAttemptAt = 0;
  private promptPending = false;
  private saidTotalsOnly = false;

  constructor(private readonly gateway: GatewayOptions, private readonly strategyId: StrategyId, private readonly botId: string, private readonly enabled: boolean) {
    const previous = Date.parse(loadRuntimeState(botId).lastReportAt ?? "");
    if (Number.isFinite(previous)) this.lastAttemptAt = previous;
  }

  /** Called when an order is acknowledged, so the trade shows up without waiting out the five minutes. */
  requestPrompt(): void {
    this.promptPending = true;
  }

  due(now: number): boolean {
    if (!this.enabled) return false;
    const elapsed = now - this.lastAttemptAt;
    return elapsed >= REPORT_INTERVAL_MS || (this.promptPending && elapsed >= PROMPT_REPORT_INTERVAL_MS);
  }

  /** `figures` may return null when the numbers are not trustworthy right now; then nothing is sent. Returns a line to log only on failure. */
  async maybeSend(now: number, lastAction: string, figures: () => Promise<ReportFigures | null>): Promise<string | null> {
    if (!this.due(now)) return null;
    this.lastAttemptAt = now;
    this.promptPending = false;
    try {
      const values = await figures();
      if (!values) return null;
      const report = buildReport(values, lastAction, now);
      let result = await postReport(this.gateway, this.strategyId, report);
      let note: string | null = null;
      const extras = report.positions !== undefined || report.trades !== undefined || report.walletAddress !== undefined;
      // A report that fails the local check is dropped, and a gateway that predates positions and trades refuses the body. The totals still go up.
      if (!result.ok && extras && (result.dropped === true || result.status === 400 || result.status === 413 || result.status === 422)) {
        const first = result;
        result = await postReport(this.gateway, this.strategyId, totalsOnly(report));
        // A dropped report is said every time. A gateway that refuses the newer fields is said once.
        if (result.ok && (first.dropped === true || !this.saidTotalsOnly)) {
          if (first.dropped !== true) this.saidTotalsOnly = true;
          note = `The report's positions and trades were left out (${first.message}). The totals were sent. Trading is not affected.`;
        }
      }
      saveRuntimeState(this.botId, { ...loadRuntimeState(this.botId), lastReportAt: new Date(now).toISOString() });
      return result.ok ? note : `The report was not sent (${result.message}). Trading is not affected.`;
    } catch {
      return "The report was not sent (the figures could not be read). Trading is not affected.";
    }
  }
}
