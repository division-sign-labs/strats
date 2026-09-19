// What the droplet's automatic buyback measures profit from, sent by the
// creator's machine: the payout record so far, so profit that was already split
// is never split again, and for a Polymarket bot the deposits figure strats fund
// recorded. It travels as one file next to the runtime state, holds no secret,
// and gives the droplet nothing to act on. Without it the droplet pays nothing.
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { buybackBasisFile, writePrivateFile } from "../paths.js";
import { LedgerLineSchema, appendLedger, readLedger, writePayoutSummary } from "../payouts.js";
import { loadRuntimeState } from "../runtime-state.js";

const BASIS_MAX_LINES = 5000;

export const BasisSchema = z.object({
  v: z.literal(1),
  /** When the creator's machine wrote it. */
  at: z.string(),
  /** Polymarket only: everything ever deposited, as recorded on the creator's machine, and when that figure was taken. */
  netDepositsUsd: z.number().nonnegative().optional(),
  netDepositsAt: z.string().optional(),
  /** Every line of the creator's payout record. The droplet adds the ones it does not have; it never removes one. */
  ledger: z.array(LedgerLineSchema).max(BASIS_MAX_LINES),
  /** True while strats fund waits for a deposit: a deposit must never be measured as profit. */
  hold: z.boolean().optional(),
});
export type BuybackBasis = z.infer<typeof BasisSchema>;

/** Built on the creator's machine from its own payout record and deposits figure. */
export function buildBasis(botId: string, opts: { hold?: boolean; now?: number } = {}): BuybackBasis {
  const ledger = readLedger(botId);
  if (ledger.skipped > 0) throw new Error("A line of the payout record on this machine cannot be read, so it is not sent to the droplet. Repair or remove the damaged line first.");
  const state = loadRuntimeState(botId);
  return BasisSchema.parse({
    v: 1, at: new Date(opts.now ?? Date.now()).toISOString(), ledger: ledger.lines,
    ...(state.netDepositsUsd !== undefined ? { netDepositsUsd: state.netDepositsUsd } : {}),
    ...(state.netDepositsAt !== undefined ? { netDepositsAt: state.netDepositsAt } : {}),
    ...(opts.hold === true ? { hold: true } : {}),
  });
}

export const basisFileBody = (basis: BuybackBasis): string => `${JSON.stringify(BasisSchema.parse(basis))}\n`;

/** For tests and for a bot that runs where it was set up. */
export function saveBasis(botId: string, basis: BuybackBasis): void {
  writePrivateFile(buybackBasisFile(botId), basisFileBody(basis));
}

/** Null when there is no file or it cannot be read. Either way the droplet pays nothing. */
export function loadBasis(botId: string): BuybackBasis | null {
  try {
    const path = buybackBasisFile(botId);
    if (!existsSync(path)) return null;
    const parsed = BasisSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Add the creator's lines this record does not have. A line is never added twice, and the totals the report reads are rewritten. */
export function mergeBasisLedger(botId: string, basis: BuybackBasis): number {
  let added = 0;
  for (const line of basis.ledger) if (appendLedger(botId, line)) added += 1;
  if (added === 0) writePayoutSummary(botId);
  return added;
}
