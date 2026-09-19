// strats close: cancel our exits by id and close the position with a reduce-only order, after a y/N confirm.
import type { Args } from "../args.js";
import { fetchTarget } from "../client.js";
import { dexOfCoin } from "../protocol/index.js";
import { px } from "../reconcile.js";
import { fetchThemeConfig } from "../client.js";
import { loadAgentKey, loadPolymarketCreds, openSession, scrub, sessionSecrets, type Session } from "../session.js";
import type { Prompts } from "../setup.js";
import { Venue } from "../venue.js";
import { PolymarketVenue, polymarketGeoblock } from "../venue-polymarket.js";

/** Theme bots: sell every position in a configured market at the bid. Positions in other markets are left alone. */
async function closeTheme(session: Session, prompts: Prompts): Promise<number> {
  const { bot } = session;
  if (!bot.polymarket) throw new Error("This bot has no Polymarket account yet.");
  const config = await fetchThemeConfig(session.gateway);
  if (!config.ok) {
    console.log(`Could not read the configured markets. ${config.message} Nothing was changed.`);
    return 1;
  }
  const geo = await polymarketGeoblock();
  if (geo?.blocked) {
    console.log(`Polymarket does not accept orders from ${geo.country}, so positions cannot be sold from here. Nothing was changed.`);
    return 1;
  }
  const markets = config.value.config.strategy.markets;
  const creds = loadPolymarketCreds(session);
  const venue = new PolymarketVenue(bot.polymarket, creds);
  const snap = await venue.snapshot(markets, markets.flatMap((m) => m.tokenIds));
  const ours = snap.holdings.filter((h) => markets.some((m) => m.tokenIds.includes(h.tokenId)));
  if (ours.length === 0) {
    console.log("There are no positions in the configured markets.");
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
  if (bot.strategyId === "theme") return closeTheme(session, prompts);
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
