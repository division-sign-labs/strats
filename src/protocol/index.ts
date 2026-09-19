// The two documents the gateway serves. Extra fields from the server are
// ignored so the server can grow; a missing or invalid required field is a
// parse failure, which the runner treats as HOLD.
import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const STRATEGY_ID = "stock-ls";

const isoTime = z.string().refine((value) => Number.isFinite(Date.parse(value)), "not an ISO time");
const price = z.number().positive().finite();

export const TokenSchema = z.object({
  chainId: z.number().int().positive(),
  address: z.string().min(1),
});

export const SplitSchema = z.object({
  buybackPct: z.number().min(0).max(100),
  keepPct: z.number().min(0).max(100),
});

export const ConfigDocSchema = z.object({
  strategyId: z.literal(STRATEGY_ID),
  version: z.number().int().nonnegative(),
  updatedAt: isoTime,
  config: z.object({
    v: z.literal(PROTOCOL_VERSION),
    strategyId: z.literal(STRATEGY_ID),
    strategy: z.object({ assetKey: z.string().min(1) }),
    account: z.object({
      positionPct: z.number().min(1).max(50),
      token: TokenSchema,
      split: SplitSchema,
    }),
  }),
});

export const TargetDocSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  strategyId: z.literal(STRATEGY_ID),
  asOf: isoTime,
  validUntil: isoTime,
  mode: z.enum(["open", "reduce-only"]),
  target: z.object({
    assetKey: z.string().min(1),
    coin: z.string().min(1),
    dex: z.string(),
    side: z.enum(["long", "short", "flat"]),
    flatReason: z.enum(["neutral", "expired", "unavailable"]).nullable(),
    entryLimit: price.nullable(),
    targetPx: price.nullable(),
    stopPx: price.nullable(),
    expiresAt: isoTime.nullable(),
    signalId: z.string().min(1).nullable(),
    revision: z.number().int().nonnegative().nullable(),
    reason: z.string(),
  }),
});

export type Token = z.infer<typeof TokenSchema>;
export type Split = z.infer<typeof SplitSchema>;
export type ConfigDoc = z.infer<typeof ConfigDocSchema>;
export type TargetDoc = z.infer<typeof TargetDocSchema>;
export type Target = TargetDoc["target"];
export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid document";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

export function parseConfig(input: unknown): ParseResult<ConfigDoc> {
  const parsed = ConfigDocSchema.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: describe(parsed.error) };
}

/** The venue coin carries its own dex prefix: "BTC" is "", "xyz:NVDA" is "xyz". */
export function dexOfCoin(coin: string): string | null {
  if (coin.trim() !== coin) return null;
  const parts = coin.split(":");
  if (parts.length === 1 && parts[0]) return "";
  if (parts.length === 2 && parts[0] && parts[1]) return parts[0];
  return null;
}

/** Field checks plus the cross-field rules a directional or flat target must satisfy. */
export function parseTarget(input: unknown): ParseResult<TargetDoc> {
  const parsed = TargetDocSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: describe(parsed.error) };
  const doc = parsed.data;
  const t = doc.target;
  if (dexOfCoin(t.coin) !== t.dex) return { ok: false, reason: `target.coin "${t.coin}" does not belong to dex "${t.dex}"` };
  if (t.side === "flat") {
    if (t.flatReason === null) return { ok: false, reason: "target.flatReason: a flat target needs a reason" };
    return { ok: true, value: doc };
  }
  // expiresAt, signalId and revision may be null on a directional target: the server passes them through from the signal.
  if (t.entryLimit === null || t.targetPx === null || t.stopPx === null) {
    return { ok: false, reason: `target: a ${t.side} target needs entryLimit, targetPx and stopPx` };
  }
  const ordered = t.side === "long"
    ? t.stopPx < t.entryLimit && t.entryLimit < t.targetPx
    : t.targetPx < t.entryLimit && t.entryLimit < t.stopPx;
  if (!ordered) return { ok: false, reason: `target: stop, entry limit and target are not in order for a ${t.side}` };
  return { ok: true, value: doc };
}
