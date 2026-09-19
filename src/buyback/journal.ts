// The write-ahead record of the one buyback in flight. It is saved with the
// NEXT stage before the action that makes that stage true, and every
// transaction is signed, and its hash and nonce saved, before it is broadcast.
// So after any stop, the file says the most that can have happened, and a
// second run can look for evidence instead of sending anything again.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { z } from "zod";
import { buybackJournalFile, ensurePrivateDir, stateDir, writePrivateFile } from "../paths.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const units = z.string().regex(/^[0-9]+$/);

export const STAGES = ["confirmed", "withdraw_sending", "withdraw_sent", "arrived", "approve_sending", "approved", "swap_sending", "swap_sent"] as const;
export type Stage = (typeof STAGES)[number];

/** A transaction that was signed. `earlier` keeps the hashes of signatures it replaced, all with the same nonce, so whichever one was mined is found. */
const SentTx = z.object({ nonce: z.number().int().nonnegative(), hash, earlier: z.array(hash).max(20).optional() });
export type SentTx = z.infer<typeof SentTx>;

export const JournalSchema = z.object({
  v: z.literal(1),
  /** The payout id. It ties the journal to its lines in the payout record. */
  id: z.string().min(1),
  startedAt: z.string(),
  venue: z.enum(["hyperliquid", "polymarket"]),
  /** Hyperliquid only: the dex the money comes from. "" is the main dex. */
  dex: z.string().optional(),
  /** W: what leaves the venue, USD. */
  withdrawUsd: z.number().positive(),
  /** A: what reaches the wallet and is swapped, in units of the 6-decimal source token. Never "whatever the wallet holds". */
  arriveUnits: units,
  /** What the venue keeps from the withdrawal, USD. */
  feeUsd: z.number().nonnegative(),
  profitSettledUsd: z.number().nonnegative(),
  buybackPct: z.number().min(0).max(100),
  token: z.object({ chainId: z.number().int().positive(), address }),
  /** For the last line only. They come from the quote the user saw. */
  tokenSymbol: z.string().max(40),
  tokenDecimals: z.number().int().min(0).max(36),
  destination: address,
  /** The least the swap may promise, in token units. Fixed when the user said yes. */
  floorMinOut: units,
  /** The wallet's source-token balance before anything was sent. Arrival is measured against it. */
  walletBalanceBeforeUnits: units,
  stage: z.enum(STAGES),
  withdrawSentAt: z.string().optional(),
  approve: SentTx.optional(),
  swap: SentTx.extend({ quoteMinOut: units, tool: z.string().max(80).optional() }).optional(),
  note: z.string().max(400).optional(),
});
export type Journal = z.infer<typeof JournalSchema>;

export interface JournalStore {
  /** Null when no buyback is in flight. Throws when a file exists and cannot be read: then nothing may be started. */
  load(): Journal | null;
  /** The first write of a new buyback. It fails when a journal already exists, so two runs at once cannot both start one. */
  create(journal: Journal): void;
  save(journal: Journal): void;
  remove(): void;
}

export function fileJournal(botId: string): JournalStore {
  const path = buybackJournalFile(botId);
  return {
    load() {
      if (!existsSync(path)) return null;
      let parsed: ReturnType<typeof JournalSchema.safeParse>;
      try {
        parsed = JournalSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        throw new Error(unreadable(path));
      }
      if (!parsed.success) throw new Error(unreadable(path));
      return parsed.data;
    },
    create(journal) {
      ensurePrivateDir(stateDir());
      let fd: number;
      try {
        // "wx": the file must not exist. The check and the creation are one step.
        fd = openSync(path, "wx", 0o600);
      } catch {
        throw new Error("A buyback is already in flight.");
      }
      try {
        writeSync(fd, `${JSON.stringify(JournalSchema.parse(journal), null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    save(journal) {
      writePrivateFile(path, `${JSON.stringify(JournalSchema.parse(journal), null, 2)}\n`);
    },
    remove() {
      rmSync(path, { force: true });
    },
  };
}

const unreadable = (path: string): string =>
  `A buyback was started earlier and its record at ${path} cannot be read, so it is not known what was sent. Nothing new is started while it is there. Check the wallet and the venue before removing it.`;
