// A managed key names no markets: the server chooses them, adds new ones and
// drops ended ones. So there is no list the creator chose to check a target
// against. Instead every market a targets document names is looked up on
// Polymarket itself, and is traded only when Polymarket says the token belongs
// to the market the document names. Pure: the lookups come in as `facts`.
import type { ThemeMarket, ThemeTargetsDoc } from "./protocol/index.js";

/** What Polymarket says about one token's market. */
export interface MarketFacts {
  conditionId: string;
  tokens: ReadonlyArray<{ tokenId: string; outcome: string }>;
}

export interface ManagedMarkets {
  markets: ThemeMarket[];
  /** One short sentence per market that could not be confirmed. */
  refused: string[];
}

const short = (conditionId: string): string => (conditionId.length > 12 ? `${conditionId.slice(0, 10)}...` : conditionId);

function marketFrom(facts: MarketFacts | undefined, tokenId: string, question: string, namedCondition: string | null): ThemeMarket | string {
  if (!facts) return "Polymarket could not confirm this market, refused.";
  const [first, second] = facts.tokens;
  if (facts.tokens.length !== 2 || !first || !second || first.tokenId === second.tokenId) return "Polymarket does not list two outcomes for this market, refused.";
  if (namedCondition !== null && facts.conditionId.toLowerCase() !== namedCondition.toLowerCase()) return "Polymarket lists this token under another market, refused.";
  const side = first.tokenId === tokenId ? 0 : second.tokenId === tokenId ? 1 : null;
  if (side === null) return "the token is not in this market, refused.";
  return { conditionId: facts.conditionId, tokenIds: [first.tokenId, second.tokenId], outcomes: [first.outcome, second.outcome], side, question: question.slice(0, 300), marketKey: null };
}

/**
 * The markets of one cycle: every target's market, and the market of every token in `heldTokenIds` (so a holding can be sold or
 * redeemed when the document says it closed, and is counted in the report). `side` is the outcome the target buys, or the one held.
 */
export function managedMarketsForCycle(doc: Pick<ThemeTargetsDoc, "targets" | "closed">, facts: ReadonlyMap<string, MarketFacts>, heldTokenIds: readonly string[] = []): ManagedMarkets {
  const byCondition = new Map<string, ThemeMarket>();
  const refused: string[] = [];
  for (const target of doc.targets) {
    const market = marketFrom(facts.get(target.tokenId), target.tokenId, target.question, target.conditionId);
    if (typeof market === "string") refused.push(`${short(target.conditionId)}: ${market}`);
    else byCondition.set(market.conditionId.toLowerCase(), { ...market, conditionId: target.conditionId });
  }
  const closedCondition = new Map(doc.closed.map((c) => [c.tokenId, c.conditionId]));
  for (const tokenId of heldTokenIds) {
    const named = closedCondition.get(tokenId) ?? null;
    const market = marketFrom(facts.get(tokenId), tokenId, "", named);
    if (typeof market === "string") {
      if (named !== null) refused.push(`${short(named)}: ${market}`);
      continue;
    }
    const key = market.conditionId.toLowerCase();
    // A market with a target keeps the target's side: the side only matters for a buy.
    if (!byCondition.has(key)) byCondition.set(key, named !== null ? { ...market, conditionId: named } : market);
  }
  return { markets: [...byCondition.values()], refused };
}
