// Counters the run loop keeps between restarts. None of it is secret and none
// of it is needed to trade safely: the venue is always read fresh. It exists so
// the report can carry a cumulative volume, and so a theme bot enters each
// market once. A missing or damaged file is treated as empty.
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { runtimeStateFile, writePrivateFile } from "./paths.js";

const RuntimeStateSchema = z.object({
  v: z.literal(1),
  /** Cumulative notional traded, USD. Never decreases. */
  volumeUsd: z.number().nonnegative().default(0),
  /** Polymarket only: the wallet value the runner measures profit from. */
  netDepositsUsd: z.number().optional(),
  lastReportAt: z.string().optional(),
  lastAction: z.string().max(200).optional(),
  /** Theme target id -> when it was entered. A market is entered once. */
  entered: z.record(z.string(), z.string()).default({}),
  /** Theme target id -> when an order went out whose result is unknown. Blocks a second order for a while. */
  attempted: z.record(z.string(), z.string()).default({}),
  /** Condition id -> when a redemption was submitted. A redemption is never sent twice. */
  redeemed: z.record(z.string(), z.string()).default({}),
});
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

export const emptyRuntimeState = (): RuntimeState => RuntimeStateSchema.parse({ v: 1 });

export function loadRuntimeState(id: string): RuntimeState {
  try {
    const path = runtimeStateFile(id);
    if (!existsSync(path)) return emptyRuntimeState();
    const parsed = RuntimeStateSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : emptyRuntimeState();
  } catch {
    return emptyRuntimeState();
  }
}

/** A failed write never stops the loop. */
export function saveRuntimeState(id: string, state: RuntimeState): void {
  try {
    writePrivateFile(runtimeStateFile(id), `${JSON.stringify(RuntimeStateSchema.parse(state), null, 2)}\n`);
  } catch {
    // Counters only; the next cycle tries again.
  }
}
