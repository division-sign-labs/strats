// The documents the gateway serves, and the one report the runner sends back.
// Extra fields from the server are ignored so the server can grow; a missing
// or invalid required field is a parse failure, which the runner treats as HOLD.
import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const STRATEGY_ID = "stock-ls";
export const THEME_STRATEGY_ID = "theme";
export const STRATEGY_IDS = [STRATEGY_ID, THEME_STRATEGY_ID] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];

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

/** Shown on the public Projects page. It never feeds a decision. */
export const ProfileSchema = z.object({
  name: z.string().min(1).max(40),
  imageUrl: z.string().max(500).nullable(),
  listed: z.boolean(),
});
/** Display only, so a profile this version cannot read is dropped rather than failing the settings and stopping the runner. */
const optionalProfile = ProfileSchema.optional().catch(undefined);

export const AccountSchema = z.object({
  positionPct: z.number().min(1).max(50),
  token: TokenSchema,
  split: SplitSchema,
});

export const ConfigDocSchema = z.object({
  strategyId: z.literal(STRATEGY_ID),
  version: z.number().int().nonnegative(),
  updatedAt: isoTime,
  config: z.object({
    v: z.literal(PROTOCOL_VERSION),
    strategyId: z.literal(STRATEGY_ID),
    strategy: z.object({ assetKey: z.string().min(1), direction: z.enum(["both", "long", "short"]).optional() }),
    account: AccountSchema,
    profile: optionalProfile,
  }),
});

const tokenPair = z.tuple([z.string().min(1), z.string().min(1)]);

/** One Polymarket market the creator chose. `side` is the index of the outcome the theme buys. */
export const ThemeMarketSchema = z.object({
  conditionId: z.string().min(1),
  tokenIds: tokenPair,
  outcomes: tokenPair,
  side: z.union([z.literal(0), z.literal(1)]),
  question: z.string().max(300),
  marketKey: z.string().nullable(),
});

export const ThemeConfigDocSchema = z.object({
  strategyId: z.literal(THEME_STRATEGY_ID),
  version: z.number().int().nonnegative(),
  updatedAt: isoTime,
  config: z.object({
    v: z.literal(PROTOCOL_VERSION),
    strategyId: z.literal(THEME_STRATEGY_ID),
    strategy: z.object({ thesis: z.string().min(3).max(600), markets: z.array(ThemeMarketSchema).min(1).max(40) }),
    account: AccountSchema,
    profile: optionalProfile,
  }),
});

const probability = z.number().min(0).max(1);

export const ThemeTargetSchema = z.object({
  id: z.string().min(1),
  venue: z.literal("polymarket"),
  conditionId: z.string().min(1),
  tokenId: z.string().min(1),
  outcome: z.string(),
  question: z.string(),
  /** Never pay above this. */
  maxPrice: probability,
  takeProfitPrice: probability,
  expiresAt: isoTime.nullable(),
  rule: z.enum(["q", "market"]),
  q: probability.nullable(),
  reason: z.string(),
});

export const ThemeTargetsSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  strategyId: z.literal(THEME_STRATEGY_ID),
  asOf: isoTime,
  validUntil: isoTime,
  mode: z.enum(["open", "reduce-only"]),
  targets: z.array(ThemeTargetSchema).max(200),
  closed: z.array(z.object({ conditionId: z.string().min(1), tokenId: z.string().min(1), reason: z.string() })).max(200),
});

/** The report body limit on the gateway, in bytes. A larger report is dropped here rather than sent. */
export const REPORT_MAX_BYTES = 24 * 1024;
export const REPORT_MAX_POSITIONS = 20;
export const REPORT_MAX_TRADES = 30;
export const REPORT_LABEL_MAX = 80;

const reportLabel = z.string().min(1).max(REPORT_LABEL_MAX);
/** `side` and `action` are shown as short tags: letters, digits, space, period, apostrophe and hyphen only. */
const shortWord = z.string().regex(/^[A-Za-z0-9 .'-]{1,12}$/).refine((value) => value.trim() !== "", "blank");
const usdAmount = z.number().finite().nonnegative();
const nullableNumber = z.number().finite().nullable();

/** One holding, in plain words. Display only. */
export const ReportPositionSchema = z.strictObject({
  /** What is held: the asset name, or the market question. */
  label: reportLabel,
  venue: z.enum(["hyperliquid", "polymarket"]),
  /** "long", "short", or the outcome bought, such as "Yes". */
  side: shortWord,
  sizeUsd: usdAmount,
  entryPrice: nullableNumber,
  markPrice: nullableNumber,
  pnlUsd: nullableNumber,
});

/** One action this runner took. Display only. */
export const ReportTradeSchema = z.strictObject({
  at: isoTime,
  label: reportLabel,
  /** "open", "close", "buy", "sell" or "redeem". */
  action: shortWord,
  sizeUsd: usdAmount,
  price: nullableNumber,
});

/** The one document the runner sends up. Display only: the server never reads it to decide anything. */
export const ReportSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  at: isoTime,
  venue: z.enum(["hyperliquid", "polymarket"]),
  equityUsd: z.number().finite(),
  netDepositsUsd: z.number().finite(),
  profitUsd: z.number().finite(),
  volumeUsd: z.number().finite().nonnegative(),
  boughtBackUsd: z.number().finite().nonnegative(),
  openPositions: z.number().int().nonnegative(),
  lastAction: z.string().max(200),
  /** What the bot holds. At most 20. */
  positions: z.array(ReportPositionSchema).max(REPORT_MAX_POSITIONS).optional(),
  /** The last actions this runner took, newest first. At most 30. */
  trades: z.array(ReportTradeSchema).max(REPORT_MAX_TRADES).optional(),
  /** Present only when the creator chose to publish the wallet. Absent by default. */
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
});

export const TargetDocSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  strategyId: z.literal(STRATEGY_ID),
  asOf: isoTime,
  validUntil: isoTime,
  mode: z.enum(["open", "reduce-only"]),
  target: z.object({
    assetKey: z.string().min(1),
    /** Display only, and optional: the asset's plain name when the server sends one. It never feeds a decision. */
    name: z.string().max(80).optional().catch(undefined),
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
export type ThemeConfigDoc = z.infer<typeof ThemeConfigDocSchema>;
export type AnyConfigDoc = ConfigDoc | ThemeConfigDoc;
export type ThemeMarket = z.infer<typeof ThemeMarketSchema>;
export type ThemeTarget = z.infer<typeof ThemeTargetSchema>;
export type ThemeTargetsDoc = z.infer<typeof ThemeTargetsSchema>;
export type Report = z.infer<typeof ReportSchema>;
export type ReportPosition = z.infer<typeof ReportPositionSchema>;
export type ReportTrade = z.infer<typeof ReportTradeSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type TargetDoc = z.infer<typeof TargetDocSchema>;
export type Target = TargetDoc["target"];
export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid document";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Check an outgoing report against the contract and the body limit. A report that fails either is dropped by the caller, never sent. */
export function encodeReport(input: unknown): ParseResult<string> {
  const parsed = ReportSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: `the report did not match the protocol (${describe(parsed.error)})` };
  const body = JSON.stringify(parsed.data);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > REPORT_MAX_BYTES) return { ok: false, reason: `the report is ${bytes} bytes and the limit is ${REPORT_MAX_BYTES}` };
  return { ok: true, value: body };
}

export function parseConfig(input: unknown): ParseResult<ConfigDoc> {
  const parsed = ConfigDocSchema.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: describe(parsed.error) };
}

export function parseThemeConfig(input: unknown): ParseResult<ThemeConfigDoc> {
  const parsed = ThemeConfigDocSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: describe(parsed.error) };
  const seen = new Set<string>();
  for (const market of parsed.data.config.strategy.markets) {
    if (market.tokenIds[0] === market.tokenIds[1]) return { ok: false, reason: `market ${market.conditionId}: the two token ids are the same` };
    if (seen.has(market.conditionId)) return { ok: false, reason: `market ${market.conditionId} is listed twice` };
    seen.add(market.conditionId);
  }
  return { ok: true, value: parsed.data };
}

/** Field checks plus the identity rules every target must satisfy: one entry per market, and the id names the market. */
export function parseThemeTargets(input: unknown): ParseResult<ThemeTargetsDoc> {
  const parsed = ThemeTargetsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: describe(parsed.error) };
  const doc = parsed.data;
  if (Date.parse(doc.validUntil) <= Date.parse(doc.asOf)) return { ok: false, reason: "validUntil is not after asOf" };
  const seen = new Set<string>();
  for (const target of doc.targets) {
    if (!target.id.startsWith(`${target.conditionId}:`)) return { ok: false, reason: `target ${target.id} does not name its market` };
    if (seen.has(target.conditionId)) return { ok: false, reason: `market ${target.conditionId} is targeted twice` };
    seen.add(target.conditionId);
  }
  for (const closed of doc.closed) {
    if (seen.has(closed.conditionId)) return { ok: false, reason: `market ${closed.conditionId} is both targeted and closed` };
  }
  return { ok: true, value: doc };
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
