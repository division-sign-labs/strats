// The documents the gateway serves, and the one report the runner sends back.
// Extra fields from the server are ignored so the server can grow; a missing
// or invalid required field is a parse failure, which the runner treats as HOLD.
import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const STRATEGY_ID = "stock-ls";
export const THEME_STRATEGY_ID = "theme";
export const TEAM_STRATEGY_ID = "team";
export const STRATEGY_IDS = [STRATEGY_ID, THEME_STRATEGY_ID, TEAM_STRATEGY_ID] as const;
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

const tokenPair = z.tuple([z.string().min(1), z.string().min(1)]);

/**
 * One Polymarket market the creator chose. `side` is the index of the outcome the theme buys.
 * On a single-asset key it is the outcome that is good for someone long the asset.
 */
export const ThemeMarketSchema = z.object({
  conditionId: z.string().min(1),
  tokenIds: tokenPair,
  outcomes: tokenPair,
  side: z.union([z.literal(0), z.literal(1)]),
  question: z.string().max(300),
  marketKey: z.string().nullable(),
});

export const MAX_CONFIGURED_MARKETS = 40;

export const ConfigDocSchema = z.object({
  strategyId: z.literal(STRATEGY_ID),
  version: z.number().int().nonnegative(),
  updatedAt: isoTime,
  config: z.object({
    v: z.literal(PROTOCOL_VERSION),
    strategyId: z.literal(STRATEGY_ID),
    strategy: z.object({
      assetKey: z.string().min(1),
      direction: z.enum(["both", "long", "short"]).optional(),
      /** Legacy keys: the asset's Polymarket markets, chosen on TokenStrats. Absent or empty, with no universe, means the bot trades the perp only. */
      markets: z.array(ThemeMarketSchema).max(MAX_CONFIGURED_MARKETS).optional(),
      /** "managed": the server chooses the asset's Polymarket markets, adds new ones and drops ended ones. `markets` is then absent. */
      universe: z.literal("managed").optional(),
    }),
    account: AccountSchema,
    profile: optionalProfile,
  }),
});

export const ThemeConfigDocSchema = z.object({
  strategyId: z.literal(THEME_STRATEGY_ID),
  version: z.number().int().nonnegative(),
  updatedAt: isoTime,
  config: z.object({
    v: z.literal(PROTOCOL_VERSION),
    strategyId: z.literal(THEME_STRATEGY_ID),
    /** Either `universe: "managed"`, where the server chooses the markets that fit the theme, or a legacy list the creator chose. Never both. */
    strategy: z.object({
      thesis: z.string().min(3).max(600),
      markets: z.array(ThemeMarketSchema).min(1).max(MAX_CONFIGURED_MARKETS).optional(),
      universe: z.literal("managed").optional(),
    }),
    account: AccountSchema,
    profile: optionalProfile,
  }),
});

/** The leagues a team can come from, and the sport each belongs to. */
export const TEAM_LEAGUES = ["mlb", "nfl", "epl", "mls", "atp", "wta"] as const;
export const TEAM_SPORTS = ["baseball", "football", "soccer", "tennis"] as const;
/** The five ways to bet on a team. The margin modes read the lead in the market, in points. */
export const TEAM_BET_MODES = [
  { value: "back", label: "Always back them", usesMargin: false },
  { value: "against", label: "Always bet against them", usesMargin: false },
  { value: "follow", label: "Follow the market", usesMargin: true },
  { value: "back-favored", label: "Back them only when favored", usesMargin: true },
  { value: "against-favored", label: "Bet against them only when the market does", usesMargin: true },
] as const;
export type TeamBetMode = (typeof TEAM_BET_MODES)[number]["value"];

export const TeamStrategySchema = z.object({
  team: z.object({
    /** Polymarket's numeric team id, as a string. */
    id: z.string().min(1).max(12),
    name: z.string().min(1).max(80),
    alias: z.string().max(80).nullable().default(null),
    abbreviation: z.string().max(16).nullable().default(null),
    league: z.enum(TEAM_LEAGUES),
    sport: z.enum(TEAM_SPORTS),
  }),
  mode: z.enum(["back", "against", "follow", "back-favored", "against-favored"]),
  /** The lead the favorite needs, in points. Read by the three margin modes only. */
  marginPts: z.number().int().min(0).max(40),
  /** Never pay above this, in cents. */
  maxPriceCents: z.number().int().min(5).max(95),
});

export const TeamConfigDocSchema = z.object({
  strategyId: z.literal(TEAM_STRATEGY_ID),
  version: z.number().int().nonnegative(),
  updatedAt: isoTime,
  config: z.object({
    v: z.literal(PROTOCOL_VERSION),
    strategyId: z.literal(TEAM_STRATEGY_ID),
    strategy: TeamStrategySchema,
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

/** One game market of the team's. `teamSide` is the index of the outcome that is the team winning. */
export const TeamMarketSchema = z.object({
  conditionId: z.string().min(1),
  tokenIds: tokenPair,
  outcomes: tokenPair,
  teamSide: z.union([z.literal(0), z.literal(1)]),
  question: z.string().max(300),
  gameStartTime: isoTime,
  /** Display only, so a state this version cannot read is shown as upcoming rather than failing the document. */
  state: z.enum(["upcoming", "live", "closed"]).catch("upcoming"),
});

/** The theme document plus the games it was built from. The literal id keeps a team runner from ever accepting a theme document, and the reverse. */
export const TeamTargetsSchema = ThemeTargetsSchema.extend({
  strategyId: z.literal(TEAM_STRATEGY_ID),
  markets: z.array(TeamMarketSchema).max(60),
});

/**
 * The targets for a single-asset key's Polymarket markets: the theme document under the single-asset id.
 * The literal id keeps this runner from taking a theme or team document for it, and the reverse.
 */
export const AssetMarketsTargetsSchema = ThemeTargetsSchema.extend({ strategyId: z.literal(STRATEGY_ID) });

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
export type TeamConfigDoc = z.infer<typeof TeamConfigDocSchema>;
export type TeamStrategy = z.infer<typeof TeamStrategySchema>;
export type TeamMarket = z.infer<typeof TeamMarketSchema>;
export type TeamTargetsDoc = z.infer<typeof TeamTargetsSchema>;
export type AssetMarketsTargetsDoc = z.infer<typeof AssetMarketsTargetsSchema>;
export type AnyConfigDoc = ConfigDoc | ThemeConfigDoc | TeamConfigDoc;
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

/** The rules a list of configured markets must satisfy beyond its fields: two different tokens, and each market once. Null means they hold. */
function configuredMarketsProblem(markets: readonly ThemeMarket[]): string | null {
  const seen = new Set<string>();
  for (const market of markets) {
    if (market.tokenIds[0] === market.tokenIds[1]) return `market ${market.conditionId}: the two token ids are the same`;
    if (seen.has(market.conditionId)) return `market ${market.conditionId} is listed twice`;
    seen.add(market.conditionId);
  }
  return null;
}

export function parseConfig(input: unknown): ParseResult<ConfigDoc> {
  const parsed = ConfigDocSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: describe(parsed.error) };
  const { strategy } = parsed.data.config;
  if (strategy.universe === "managed" && strategy.markets !== undefined) return { ok: false, reason: MANAGED_WITH_MARKETS };
  const problem = configuredMarketsProblem(strategy.markets ?? []);
  return problem === null ? { ok: true, value: parsed.data } : { ok: false, reason: problem };
}

const MANAGED_WITH_MARKETS = "the settings name both a managed universe and a list of markets";

/** The Polymarket markets of a legacy single-asset config. Empty for a perp-only key and for a managed one. */
export function configuredMarkets(doc: ConfigDoc): ThemeMarket[] {
  return doc.config.strategy.markets ?? [];
}

/** True when the server chooses the key's markets. The runner then trades any market a valid targets document names. */
export function isManaged(doc: { config: { strategy: object } } | undefined): boolean {
  return doc !== undefined && "universe" in doc.config.strategy && doc.config.strategy.universe === "managed";
}

/** A single-asset key trades two venues when its markets are managed or it lists some. */
export function tradesMarkets(doc: ConfigDoc): boolean {
  return isManaged(doc) || configuredMarkets(doc).length > 0;
}

export function parseThemeConfig(input: unknown): ParseResult<ThemeConfigDoc> {
  const parsed = ThemeConfigDocSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: describe(parsed.error) };
  const { strategy } = parsed.data.config;
  if (strategy.universe === "managed" && strategy.markets !== undefined) return { ok: false, reason: MANAGED_WITH_MARKETS };
  if (strategy.universe === undefined && strategy.markets === undefined) return { ok: false, reason: "the settings name no markets" };
  const problem = configuredMarketsProblem(strategy.markets ?? []);
  return problem === null ? { ok: true, value: parsed.data } : { ok: false, reason: problem };
}

export function parseTeamConfig(input: unknown): ParseResult<TeamConfigDoc> {
  const parsed = TeamConfigDocSchema.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: describe(parsed.error) };
}

/** The identity rules every Polymarket targets document must satisfy: one entry per market, and the id names the market. Null means they hold. */
function targetsIdentityProblem(doc: Pick<ThemeTargetsDoc, "asOf" | "validUntil" | "targets" | "closed">): string | null {
  if (Date.parse(doc.validUntil) <= Date.parse(doc.asOf)) return "validUntil is not after asOf";
  const seen = new Set<string>();
  for (const target of doc.targets) {
    if (!target.id.startsWith(`${target.conditionId}:`)) return `target ${target.id} does not name its market`;
    if (seen.has(target.conditionId)) return `market ${target.conditionId} is targeted twice`;
    seen.add(target.conditionId);
  }
  for (const closed of doc.closed) {
    if (seen.has(closed.conditionId)) return `market ${closed.conditionId} is both targeted and closed`;
  }
  return null;
}

/** Field checks plus the identity rules every target must satisfy: one entry per market, and the id names the market. */
export function parseThemeTargets(input: unknown): ParseResult<ThemeTargetsDoc> {
  const parsed = ThemeTargetsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: describe(parsed.error) };
  const problem = targetsIdentityProblem(parsed.data);
  return problem === null ? { ok: true, value: parsed.data } : { ok: false, reason: problem };
}

/** A single-asset key's markets follow the theme identity rules. Each target is then checked against the settings in asset-markets.ts. */
export function parseAssetMarketsTargets(input: unknown): ParseResult<AssetMarketsTargetsDoc> {
  const parsed = AssetMarketsTargetsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: describe(parsed.error) };
  const problem = targetsIdentityProblem(parsed.data);
  return problem === null ? { ok: true, value: parsed.data } : { ok: false, reason: problem };
}

/**
 * The theme rules, plus the ones a team document adds: every target is a market-rule bet with an entry
 * deadline, and every token a target or a closed entry names belongs to a game listed in `markets`.
 */
export function parseTeamTargets(input: unknown): ParseResult<TeamTargetsDoc> {
  const parsed = TeamTargetsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: describe(parsed.error) };
  const doc = parsed.data;
  const problem = targetsIdentityProblem(doc);
  if (problem !== null) return { ok: false, reason: problem };
  const games = new Map<string, TeamMarket>();
  for (const market of doc.markets) {
    const key = market.conditionId.toLowerCase();
    if (market.tokenIds[0] === market.tokenIds[1]) return { ok: false, reason: `market ${market.conditionId}: the two token ids are the same` };
    if (games.has(key)) return { ok: false, reason: `market ${market.conditionId} is listed twice` };
    games.set(key, market);
  }
  const listed = (conditionId: string, tokenId: string): boolean => games.get(conditionId.toLowerCase())?.tokenIds.includes(tokenId) === true;
  for (const target of doc.targets) {
    if (target.rule !== "market") return { ok: false, reason: `target ${target.id}: a team target follows the market rule` };
    if (target.expiresAt === null) return { ok: false, reason: `target ${target.id} has no entry deadline` };
    if (!listed(target.conditionId, target.tokenId)) return { ok: false, reason: `target ${target.id} is not one of the listed games` };
  }
  for (const closed of doc.closed) {
    if (!listed(closed.conditionId, closed.tokenId)) return { ok: false, reason: `closed market ${closed.conditionId} is not one of the listed games` };
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
