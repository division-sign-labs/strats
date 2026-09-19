// The order of strats init, as a pure function of what is already on disk.
// init walks these stages in one go; stopping at any point and running it
// again picks up at the first stage that is not finished. Nothing here reads a
// key, a file or the network.
import { isPolymarketBot, isTwoVenueBot, type BotState } from "./state.js";

/**
 * setup         read the settings, ask for the ceiling and passphrase, create the wallet
 * account       bots that trade on Polymarket: create the Polymarket account
 * fund          show the address, wait for the deposit, move it into the venue
 * fund-markets  a single-asset bot that also trades markets: fund its Polymarket account, or skip it and start with the perp only
 * deploy        put the runner on a droplet
 * done          nothing left to do
 */
export type InitStage = "setup" | "account" | "fund" | "fund-markets" | "deploy" | "done";

export type InitBot = Pick<BotState, "strategyId" | "agentAddress" | "polymarket" | "fundedAt" | "deployment" | "markets">;

export interface InitFacts {
  /** The bot file, when there is one. */
  bot: InitBot | undefined;
  /** --force: read the settings again and replace them. The wallet is kept. */
  force?: boolean;
  /** --no-deploy: stop after funding. */
  noDeploy?: boolean;
  /** Theme and team bots: whether the Polymarket API credentials are in the keystore. Unknown counts as stored. */
  polymarketCredsStored?: boolean;
}

/**
 * A bot is funded once strats fund has finished. Bots funded before 0.3.0 have
 * no record of it: an approved Hyperliquid trading key, or a droplet that is
 * already running the bot, says the same thing.
 */
export function isFunded(bot: InitBot): boolean {
  if (bot.fundedAt !== undefined || bot.deployment !== undefined) return true;
  return !isPolymarketBot(bot) && bot.agentAddress !== undefined;
}

/** The Polymarket funding step of a two-venue bot is settled once it has finished or the creator skipped it. */
export function marketsFundingSettled(bot: InitBot): boolean {
  return bot.markets?.fundedAt !== undefined || bot.markets?.skippedAt !== undefined;
}

export function nextInitStage(facts: InitFacts): InitStage {
  const { bot } = facts;
  if (!bot || facts.force === true) return "setup";
  const twoVenue = isTwoVenueBot(bot);
  // The account comes first so the funding step can show both addresses at once.
  if ((isPolymarketBot(bot) || twoVenue) && (!bot.polymarket || facts.polymarketCredsStored === false)) return "account";
  if (!isFunded(bot)) return "fund";
  if (twoVenue && !marketsFundingSettled(bot)) return "fund-markets";
  if (facts.noDeploy === true) return "done";
  // A droplet whose runner was never confirmed active is a deploy that was stopped halfway: finish it.
  return bot.deployment !== undefined && bot.deployment.pending !== true ? "done" : "deploy";
}

/** One word per stage, for the line that says where a resumed init picks up. */
export const STAGE_NAMES: Record<InitStage, string> = {
  setup: "the settings and the wallet",
  account: "the Polymarket account",
  fund: "funding",
  "fund-markets": "funding Polymarket",
  deploy: "the deploy",
  done: "nothing: every step is finished",
};
