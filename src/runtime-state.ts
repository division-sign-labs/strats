// Counters the run loop keeps between restarts. None of it is secret and none
// of it is needed to trade safely: the venue is always read fresh. It exists so
// the report can carry a cumulative volume and the runner's last trades, and so
// a theme bot enters each market once. A missing or damaged file is treated as empty.
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { marketsStateFile, runtimeStateFile, writePrivateFile } from "./paths.js";
import { REPORT_MAX_TRADES, ReportTradeSchema, type ReportTrade } from "./protocol/index.js";

const RuntimeStateSchema = z.object({
  v: z.literal(1),
  /** Cumulative notional traded, USD. Never decreases. */
  volumeUsd: z.number().nonnegative().default(0),
  /** Polymarket only: the wallet value the runner measures profit from. */
  netDepositsUsd: z.number().optional(),
  /** Polymarket only: when that figure was taken. A buyback withdrawal made after it is subtracted from it; one made before is already in it. Absent reads as the beginning of time. */
  netDepositsAt: z.string().optional(),
  lastReportAt: z.string().optional(),
  lastAction: z.string().max(200).optional(),
  /** Theme target id -> when it was entered. A market is entered once. */
  entered: z.record(z.string(), z.string()).default({}),
  /** Theme target id -> when an order went out whose result is unknown. Blocks a second order for a while. */
  attempted: z.record(z.string(), z.string()).default({}),
  /** Condition id -> when a redemption was submitted. A redemption is never sent twice. */
  redeemed: z.record(z.string(), z.string()).default({}),
  /**
   * The last actions this runner took, newest first, for display in the report.
   * A damaged list reads as empty rather than discarding the counters above.
   */
  trades: z.array(ReportTradeSchema).catch([]).default([]),
});
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

/** Put one trade at the front of the ring and keep the newest 30. Pure: the caller saves the result. */
export function appendTrade(trades: readonly ReportTrade[], trade: ReportTrade): ReportTrade[] {
  return [trade, ...trades].slice(0, REPORT_MAX_TRADES);
}

export const emptyRuntimeState = (): RuntimeState => RuntimeStateSchema.parse({ v: 1 });

/** "markets" names the Polymarket counters of a two-venue bot. Every other bot has one file. */
export type StateScope = "markets" | undefined;
const fileOf = (id: string, scope: StateScope): string => (scope === "markets" ? marketsStateFile(id) : runtimeStateFile(id));

export function loadRuntimeState(id: string, scope?: StateScope): RuntimeState {
  try {
    const path = fileOf(id, scope);
    if (!existsSync(path)) return emptyRuntimeState();
    const parsed = RuntimeStateSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : emptyRuntimeState();
  } catch {
    return emptyRuntimeState();
  }
}

/** A failed write never stops the loop. */
export function saveRuntimeState(id: string, state: RuntimeState, scope?: StateScope): void {
  try {
    writePrivateFile(fileOf(id, scope), `${JSON.stringify(RuntimeStateSchema.parse({ ...state, trades: state.trades.slice(0, REPORT_MAX_TRADES) }), null, 2)}\n`);
  } catch {
    // Counters only; the next cycle tries again.
  }
}
