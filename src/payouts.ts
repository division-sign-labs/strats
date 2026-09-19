// The record of what strats buyback has paid out. It lives on this machine
// only, is written only by strats buyback, and is only ever appended to: one
// JSON object per line. Two things read it: the buyback itself, to know what
// profit was already split, and the report, through a small summary file that
// holds the totals and nothing else. Nothing here is a secret.
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from "node:fs";
import { z } from "zod";
import { RUNNER_HOME, RUNNER_OWNER } from "./deploy/cloud-init.js";
import { remoteWriteCommand } from "./deploy/remote-write.js";
import { sshExec } from "./deploy/ssh.js";
import { usd } from "./reconcile.js";
import { ensurePrivateDir, payoutsLedgerFile, payoutsSummaryFile, stateDir, writePrivateFile } from "./paths.js";
import type { BotState } from "./state.js";

const isoTime = z.string().refine((value) => Number.isFinite(Date.parse(value)), "not an ISO time");
const usdAmount = z.number().finite().nonnegative();
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

/** Money left the venue for the wallet. Written the moment the withdrawal is known to have gone out, whether or not a swap follows. */
export const WithdrawalLineSchema = z.object({
  v: z.literal(1),
  type: z.literal("withdrawal"),
  /** The payout this belongs to. */
  id: z.string().min(1),
  at: isoTime,
  venue: z.enum(["hyperliquid", "polymarket"]),
  usd: usdAmount,
  feeUsd: usdAmount,
  /** The profit this payout settles: the buyback share and the kept share together. */
  profitSettledUsd: usdAmount,
  buybackPct: z.number().min(0).max(100),
});

/** The swap finished and the token arrived. */
export const BuybackLineSchema = z.object({
  v: z.literal(1),
  type: z.literal("buyback"),
  id: z.string().min(1),
  at: isoTime,
  spentUsd: usdAmount,
  fromChainId: z.number().int().positive(),
  token: z.object({ chainId: z.number().int().positive(), address }),
  destination: address,
  /** Token units received, as a whole number. */
  received: z.string().regex(/^[0-9]+$/),
  decimals: z.number().int().min(0).max(36),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  tool: z.string().max(80),
});

export const LedgerLineSchema = z.discriminatedUnion("type", [WithdrawalLineSchema, BuybackLineSchema]);
export type WithdrawalLine = z.infer<typeof WithdrawalLineSchema>;
export type BuybackLine = z.infer<typeof BuybackLineSchema>;
export type LedgerLine = z.infer<typeof LedgerLineSchema>;

export interface Ledger {
  lines: LedgerLine[];
  /** Lines that could not be read. They are skipped and never rewritten. */
  skipped: number;
}

/** Pure: the text of the file in, the lines out. */
export function parseLedger(text: string): Ledger {
  const lines: LedgerLine[] = [];
  let skipped = 0;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let parsed: ReturnType<typeof LedgerLineSchema.safeParse> | undefined;
    try {
      parsed = LedgerLineSchema.safeParse(JSON.parse(raw));
    } catch {
      parsed = undefined;
    }
    if (parsed?.success) lines.push(parsed.data);
    else skipped += 1;
  }
  return { lines, skipped };
}

/** A missing file is an empty record. */
export function readLedger(id: string): Ledger {
  const path = payoutsLedgerFile(id);
  return existsSync(path) ? parseLedger(readFileSync(path, "utf8")) : { lines: [], skipped: 0 };
}

/**
 * Append one line and flush it to disk. A second line with the same type and
 * payout id is refused, so repeating a step after a stop never counts a payout
 * twice. Returns false when the line was already there.
 */
export function appendLedger(id: string, line: LedgerLine): boolean {
  const checked = LedgerLineSchema.parse(line);
  const path = payoutsLedgerFile(id);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (parseLedger(existing).lines.some((l) => l.type === checked.type && l.id === checked.id)) return false;
  ensurePrivateDir(stateDir());
  // A line cut short by a crash must not swallow the next one.
  const lead = existing !== "" && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(path, `${lead}${JSON.stringify(checked)}\n`, { mode: 0o600 });
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  writePayoutSummary(id);
  return true;
}

export interface PayoutSummary {
  /** Dollars spent buying the token, finished buybacks only. */
  boughtBackUsd: number;
  /** Every withdrawal strats buyback made from the venue. */
  withdrawals: Array<{ at: string; usd: number }>;
  /** Profit already split, so it is never split again. */
  settledUsd: number;
}

const cents = (value: number): number => Math.round(value * 100) / 100;

export function summarize(lines: readonly LedgerLine[]): PayoutSummary {
  const withdrawals = lines.filter((l): l is WithdrawalLine => l.type === "withdrawal");
  const buybacks = lines.filter((l): l is BuybackLine => l.type === "buyback");
  return {
    boughtBackUsd: cents(buybacks.reduce((sum, l) => sum + l.spentUsd, 0)),
    withdrawals: withdrawals.map((l) => ({ at: l.at, usd: l.usd })),
    settledUsd: cents(withdrawals.reduce((sum, l) => sum + l.profitSettledUsd, 0)),
  };
}

export const summary = (id: string): PayoutSummary => summarize(readLedger(id).lines);

const SUMMARY_MAX_WITHDRAWALS = 500;
const SummaryFileSchema = z.object({
  v: z.literal(1),
  boughtBackUsd: usdAmount,
  withdrawals: z.array(z.object({ at: isoTime, usd: usdAmount })).max(SUMMARY_MAX_WITHDRAWALS),
});
export type PayoutSummaryFile = z.infer<typeof SummaryFileSchema>;

function summaryFileBody(id: string): string {
  const totals = summary(id);
  const newest = [...totals.withdrawals].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, SUMMARY_MAX_WITHDRAWALS);
  return `${JSON.stringify(SummaryFileSchema.parse({ v: 1, boughtBackUsd: totals.boughtBackUsd, withdrawals: newest }))}\n`;
}

/** Rewrite the summary file from the record. Called after every append. */
export function writePayoutSummary(id: string): void {
  writePrivateFile(payoutsSummaryFile(id), summaryFileBody(id));
}

/** What the report reads. A missing or damaged file means nothing was bought back. Never throws. */
export function readPayoutSummary(id: string): PayoutSummaryFile {
  try {
    const path = payoutsSummaryFile(id);
    if (!existsSync(path)) return { v: 1, boughtBackUsd: 0, withdrawals: [] };
    const parsed = SummaryFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : { v: 1, boughtBackUsd: 0, withdrawals: [] };
  } catch {
    return { v: 1, boughtBackUsd: 0, withdrawals: [] };
  }
}

/**
 * Polymarket keeps no deposit history, so deposits are a number recorded on this
 * machine at `recordedAt`. A buyback withdrawal made after that moment lowers it;
 * one made before is already inside it. An absent time reads as the beginning of time.
 */
export function depositsLessWithdrawals(netDepositsUsd: number, recordedAt: string | undefined, withdrawals: ReadonlyArray<{ at: string; usd: number }>): number {
  const since = recordedAt === undefined ? 0 : Date.parse(recordedAt);
  const floor = Number.isFinite(since) ? since : 0;
  return netDepositsUsd - withdrawals.filter((w) => Date.parse(w.at) > floor).reduce((sum, w) => sum + w.usd, 0);
}

export type PushResult = { pushed: true } | { pushed: false; reason: "not-deployed" } | { pushed: false; reason: "failed"; message: string };

/**
 * Copy the summary file to the droplet, so the deployed runner's report shows the
 * right totals. It holds two numbers and a list of dates and amounts: no secret,
 * and nothing the droplet can act on. Best effort: never throws.
 */
export function pushPayoutSummary(bot: Pick<BotState, "id" | "deployment">): PushResult {
  if (!bot.deployment) return { pushed: false, reason: "not-deployed" };
  try {
    const dir = `${RUNNER_HOME}/state`;
    const [user, group] = RUNNER_OWNER.split(":");
    const command = `install -d -m 0700 -o ${user} -g ${group} ${dir} && ${remoteWriteCommand(`${dir}/${bot.id}.payouts.json`, "0600", RUNNER_OWNER)}`;
    const result = sshExec({ host: bot.deployment.host, user: "root" }, command, summaryFileBody(bot.id), { timeoutMs: 30_000 });
    return result.ok ? { pushed: true } : { pushed: false, reason: "failed", message: (result.stderr || "ssh failed").trim().slice(0, 200) };
  } catch (error) {
    return { pushed: false, reason: "failed", message: error instanceof Error ? error.message.slice(0, 200) : "unknown error" };
  }
}

export const PUSH_FAILED_TEXT = "The droplet was not told about this buyback, so the public totals will lag. To send it: strats buyback --sync";

/** Two rows for the "Profit split" block of strats status. */
export function payoutRows(id: string): string[] {
  const { lines } = readLedger(id);
  const buybacks = lines.filter((l): l is BuybackLine => l.type === "buyback");
  const last = [...buybacks].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  const row = (label: string, value: string): string => `  ${label.padEnd(16)} ${value}`;
  return [
    row("Bought back", buybacks.length === 0 ? "nothing yet. To see what a buyback would do: strats buyback" : `${usd(summarize(lines).boughtBackUsd)} in ${buybacks.length} buyback${buybacks.length === 1 ? "" : "s"}`),
    row("Last buyback", last ? `${usd(last.spentUsd)} on ${last.at.slice(0, 10)}` : "none"),
  ];
}
