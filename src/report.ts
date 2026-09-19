// The display-only report. At most one every five minutes, never in a dry run,
// never when --no-report is given. A failure costs one log line and nothing else.
// It carries totals only: no wallet address, no order, no position detail.
import { postReport, type GatewayOptions } from "./client.js";
import type { Report, StrategyId } from "./protocol/index.js";
import { loadRuntimeState, saveRuntimeState } from "./runtime-state.js";

export const REPORT_INTERVAL_MS = 5 * 60_000;

/** Addresses and transaction hashes never travel in the report, even inside a sentence. */
export function sanitizeAction(text: string): string {
  return text.replace(/0x[0-9a-fA-F]{40,}/g, "[address]").replace(/\s+/g, " ").trim().slice(0, 200);
}

export interface ReportFigures {
  venue: Report["venue"];
  equityUsd: number;
  netDepositsUsd: number;
  volumeUsd: number;
  openPositions: number;
}

export function buildReport(figures: ReportFigures, lastAction: string, now: number): Report {
  const round = (value: number): number => Math.round(value * 100) / 100;
  return {
    v: 1,
    at: new Date(now).toISOString(),
    venue: figures.venue,
    equityUsd: round(figures.equityUsd),
    netDepositsUsd: round(figures.netDepositsUsd),
    profitUsd: round(figures.equityUsd - figures.netDepositsUsd),
    volumeUsd: round(Math.max(0, figures.volumeUsd)),
    // The buyback is not implemented in this release, so nothing has been bought back.
    boughtBackUsd: 0,
    openPositions: Math.max(0, Math.trunc(figures.openPositions)),
    lastAction: sanitizeAction(lastAction),
  };
}

export class Reporter {
  private lastAttemptAt = 0;

  constructor(private readonly gateway: GatewayOptions, private readonly strategyId: StrategyId, private readonly botId: string, private readonly enabled: boolean) {
    const previous = Date.parse(loadRuntimeState(botId).lastReportAt ?? "");
    if (Number.isFinite(previous)) this.lastAttemptAt = previous;
  }

  due(now: number): boolean {
    return this.enabled && now - this.lastAttemptAt >= REPORT_INTERVAL_MS;
  }

  /** `figures` may return null when the numbers are not trustworthy right now; then nothing is sent. Returns a line to log only on failure. */
  async maybeSend(now: number, lastAction: string, figures: () => Promise<ReportFigures | null>): Promise<string | null> {
    if (!this.due(now)) return null;
    this.lastAttemptAt = now;
    try {
      const values = await figures();
      if (!values) return null;
      const result = await postReport(this.gateway, this.strategyId, buildReport(values, lastAction, now));
      saveRuntimeState(this.botId, { ...loadRuntimeState(this.botId), lastReportAt: new Date(now).toISOString() });
      return result.ok ? null : `The report was not sent (${result.message}). Trading is not affected.`;
    } catch {
      return "The report was not sent (the figures could not be read). Trading is not affected.";
    }
  }
}
