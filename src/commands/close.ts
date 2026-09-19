// strats close: cancel our exits by id and close the position with a reduce-only order, after a y/N confirm.
import type { Args } from "../args.js";
import { fetchTarget } from "../client.js";
import { dexOfCoin } from "../protocol/index.js";
import { px } from "../reconcile.js";
import { loadAgentKey, openSession, scrub } from "../session.js";
import type { Prompts } from "../setup.js";
import { Venue } from "../venue.js";

export async function close(args: Args, prompts: Prompts): Promise<number> {
  const session = await openSession(args, prompts);
  const { bot } = session;
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
  console.log(scrub(result.text, [agentPk, session.gateway.apiKey, session.passphrase]));
  if (result.ok) console.log("A running bot will open again if Q's target still says so. Stop it first if you want to stay flat.");
  return result.ok ? 0 : 1;
}
