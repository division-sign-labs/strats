// strats close: cancel our exits by id and close the position with a reduce-only order, after a y/N confirm.
import { UsageError, type Args } from "../args.js";
import { fetchTarget, fetchTeamTargets } from "../client.js";
import { sourceFor } from "../polymarket-source.js";
import { managedMarketsForCycle } from "../managed-markets.js";
import { dexOfCoin, isManaged, type ThemeMarket } from "../protocol/index.js";
import { px, usd } from "../reconcile.js";
import { loadAgentKey, loadPolymarketCreds, openSession, scrub, sessionSecrets, type Session } from "../session.js";
import type { Prompts } from "../setup.js";
import { isPolymarketBot, isTwoVenueBot } from "../state.js";
import { teamMarketsForCycle } from "../team-markets.js";
import { Venue } from "../venue.js";
import { PolymarketVenue, polymarketGeoblock } from "../venue-polymarket.js";

/** The markets a close may sell from, or a sentence saying why they could not be read. */
async function closableMarkets(session: Session): Promise<{ ok: true; markets: ThemeMarket[] } | { ok: false; message: string }> {
  const source = sourceFor(session.bot);
  const config = await source.fetchConfig(session.gateway);
  if (!config.ok) return { ok: false, message: `Could not read the ${source.strategyId === "team" ? "settings" : "configured markets"}. ${config.message}` };
  if (isManaged(config.value)) {
    // A managed key has no list: what the wallet holds is confirmed on Polymarket, and every confirmed market may be sold from.
    const venue = new PolymarketVenue(session.bot.polymarket!, loadPolymarketCreds(session), { readOnly: true });
    const held = (await venue.snapshot([], [])).holdings.map((h) => h.tokenId);
    return { ok: true, markets: managedMarketsForCycle({ targets: [], closed: [] }, await venue.marketFacts(held), held).markets };
  }
  if (config.value.config.strategyId === "theme") return { ok: true, markets: config.value.config.strategy.markets ?? [] };
  if (config.value.config.strategyId === "stock-ls") return { ok: true, markets: config.value.config.strategy.markets ?? [] };
  // A team bot has no list of its own: its markets are the team's games, named by the targets document.
  const targets = await fetchTeamTargets(session.gateway);
  if (!targets.ok) return { ok: false, message: `Could not read the team's games. ${targets.message}` };
  // Every game that names the team may be sold from, whatever the targets say about it right now.
  return { ok: true, markets: teamMarketsForCycle({ ...targets.value, targets: [] }, config.value.config.strategy).markets };
}

/** Sell every Polymarket position in one of the bot's markets at the bid. Positions in other markets are left alone. */
async function closeTheme(session: Session, prompts: Prompts): Promise<number> {
  const { bot } = session;
  if (!bot.polymarket) throw new Error("This bot has no Polymarket account yet.");
  const readable = await closableMarkets(session);
  if (!readable.ok) {
    console.log(`${readable.message} Nothing was changed.`);
    if (bot.strategyId !== "team") return 1;
    // Without the games nothing can be sold safely, but what the venue lists can still be shown.
    try {
      const snap = await new PolymarketVenue(bot.polymarket, loadPolymarketCreds(session), { readOnly: true }).snapshot([], []);
      for (const h of snap.holdings) console.log(`Held: ${h.size} shares worth ${usd(h.valueUsd)}: ${h.label ?? h.tokenId}`);
      if (snap.holdings.length === 0) console.log("Polymarket lists no positions for this wallet. A position in a game labelled with team names shows up only once the games can be read.");
    } catch {
      console.log("The wallet could not be read either.");
    }
    console.log("Try again shortly. The wallet can also be managed on polymarket.com.");
    return 1;
  }
  const geo = await polymarketGeoblock();
  if (geo?.blocked) {
    console.log(`Polymarket does not accept orders from ${geo.country}, so positions cannot be sold from here. Nothing was changed.`);
    return 1;
  }
  const { markets } = readable;
  const creds = loadPolymarketCreds(session);
  const venue = new PolymarketVenue(bot.polymarket, creds);
  const snap = await venue.snapshot(markets, markets.flatMap((m) => m.tokenIds));
  const ours = snap.holdings.filter((h) => markets.some((m) => m.tokenIds.includes(h.tokenId)));
  if (ours.length === 0) {
    console.log(bot.strategyId === "team" ? "There are no positions in the team's games." : "There are no positions in the configured markets.");
    return 0;
  }
  for (const h of ours) console.log(`Position: ${h.size} shares, bid ${snap.quotes[h.tokenId]?.bid ?? "none"}: ${markets.find((m) => m.tokenIds.includes(h.tokenId))?.question ?? h.tokenId}`);
  if (bot.deployment) console.log(`The deployed runner on ${bot.deployment.host} will buy again if the targets still say so. Run strats destroy first if you want to stay out.`);
  if (!(await prompts.confirm(`Sell ${ours.length === 1 ? "this position" : `these ${ours.length} positions`} at the bid?`, false))) {
    console.log("Nothing was changed.");
    return 0;
  }
  prompts.close();
  let ok = true;
  for (const h of ours) {
    const market = markets.find((m) => m.tokenIds.includes(h.tokenId));
    const bid = snap.quotes[h.tokenId]?.bid ?? 0;
    if (!market || bid <= 0) {
      console.log(`No bid for ${market?.question ?? h.tokenId}. Left as is.`);
      ok = false;
      continue;
    }
    const result = await venue.sell({ kind: "sell", conditionId: market.conditionId, tokenId: h.tokenId, shares: h.size, minPrice: bid, why: "closed", reason: "Closed by the operator." }, market);
    console.log(scrub(result.text, [...sessionSecrets(session), creds.signerPk, creds.l2.secret]));
    ok = ok && result.ok;
  }
  return ok ? 0 : 1;
}

export async function close(args: Args, prompts: Prompts): Promise<number> {
  const session = await openSession(args, prompts);
  const { bot } = session;
  const venueFlag = args.values.venue;
  if (venueFlag !== undefined && venueFlag !== "hyperliquid" && venueFlag !== "polymarket") throw new UsageError("--venue takes hyperliquid or polymarket.");
  if (venueFlag !== undefined && !isTwoVenueBot(bot)) throw new UsageError("--venue applies to a single-asset bot that also trades Polymarket markets. This bot has one venue.");
  if (isPolymarketBot(bot) || venueFlag === "polymarket") return closeTheme(session, prompts);
  if (isTwoVenueBot(bot)) console.log("This closes the perp. To sell the Polymarket positions: strats close --venue polymarket");
  const agentPk = loadAgentKey(session);

  // The target names the coin. --coin covers the case where the gateway cannot be reached and you still want out.
  let coin = args.values.coin;
  if (coin === undefined) {
    const target = await fetchTarget(session.gateway);
    if (!target.ok) {
      console.log(`Could not read the target to learn the coin. ${target.message} Pass it yourself, for example: strats close --coin BTC`);
      return 1;
    }
    coin = target.value.target.coin;
  }
  const dex = dexOfCoin(coin);
  if (dex === null) throw new Error(`"${coin}" is not a valid Hyperliquid coin name.`);

  const venue = new Venue({ coin, dex, masterAddress: bot.masterAddress, agentAddress: bot.agentAddress, agentPk });
  const snap = await venue.snapshot();
  if (!snap.position) {
    console.log(`There is no ${coin} position to close.`);
    return 0;
  }
  const p = snap.position;
  console.log(`Position: ${p.side.toLowerCase()} ${p.size} ${coin} from ${px(p.avgPrice)}. Price now ${px(snap.market.quote.mid)}.`);
  if (!(await prompts.confirm("Cancel its stop and target and close it at the market?", false))) {
    console.log("Nothing was changed.");
    return 0;
  }
  prompts.close();
  const result = await venue.closePosition(snap);
  console.log(scrub(result.text, [...sessionSecrets(session), agentPk]));
  if (result.ok) console.log("A running bot will open again if Q's target still says so. Stop it first if you want to stay flat.");
  return result.ok ? 0 : 1;
}
