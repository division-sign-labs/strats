// strats config [show|accept]: compare the server's settings with the pinned payout settings, and re-pin on request.
// strats config publish-wallet [on|off]: show or change whether reports carry the wallet address.
// strats config auto-buyback [on|off]: show or change whether the droplet buys back by itself.
import { UsageError, type Args } from "../args.js";
import { fileJournal } from "../buyback/journal.js";
import { MIN_USD_DEFAULT } from "../buyback/plan.js";
import { AUTO_BUYBACK_UNAVAILABLE, autoBuybackQuestion, describeAutoBuyback } from "../buyback/text.js";
import { fetchConfigFor } from "../client.js";
import { openSession, requireKeystore } from "../session.js";
import type { Prompts } from "../setup.js";
import { autoBuybackAvailable, isPolymarketBot, pinnedDifferences, saveBot, sendsMasterKey, type BotState } from "../state.js";
import { chainName, describeConfig } from "./init.js";

/** The address a report would carry: the Hyperliquid wallet, or a theme or team bot's Polymarket deposit wallet. */
const publishableAddress = (bot: BotState): string => (isPolymarketBot(bot) ? bot.polymarket?.funder ?? "the Polymarket deposit wallet" : bot.masterAddress);

export function describePublication(bot: BotState): string {
  return bot.publishWallet === true
    ? `can show the wallet ${publishableAddress(bot)}, because each report carries it`
    : "does not show the wallet address, because reports carry none";
}

/** Whether reports carry the wallet address. Off unless the creator turns it on. */
function publishWallet(bot: BotState, value: string | undefined): number {
  if (value === undefined) {
    console.log(`The project page ${describePublication(bot)}.`);
    console.log("To change it: strats config publish-wallet on, or strats config publish-wallet off.");
    return 0;
  }
  if (value !== "on" && value !== "off") throw new UsageError("Use: strats config publish-wallet on, or strats config publish-wallet off.");
  const next = value === "on";
  if ((bot.publishWallet === true) === next) {
    console.log(`Nothing was changed. The project page ${describePublication(bot)}.`);
    return 0;
  }
  const updated: BotState = { ...bot, publishWallet: next };
  saveBot(updated);
  console.log(next
    ? `Reports now carry ${publishableAddress(updated)}, and the public project page can show it and the bot's trades. Anyone can see what that address holds.`
    : "Reports no longer carry the wallet address, starting with the next one.");
  if (bot.deployment) console.log("The droplet keeps the setting it was deployed with. To send it this one: strats deploy");
  return 0;
}

/** Whether the droplet buys back by itself. Off unless the creator turns it on, at a terminal, after the question. No flag answers it. */
async function autoBuyback(bot: BotState, value: string | undefined, prompts: Prompts): Promise<number> {
  if (value === undefined) {
    console.log(`Auto-buyback is ${describeAutoBuyback(bot)}.`);
    console.log("To change it: strats config auto-buyback on, or strats config auto-buyback off.");
    return 0;
  }
  if (value !== "on" && value !== "off") throw new UsageError("Use: strats config auto-buyback on, or strats config auto-buyback off.");
  const next = value === "on";
  if ((bot.autoBuyback === true) === next) {
    console.log(`Nothing was changed. Auto-buyback is ${describeAutoBuyback(bot)}.`);
    return 0;
  }
  if (next && !autoBuybackAvailable(bot)) {
    console.log(AUTO_BUYBACK_UNAVAILABLE);
    return 1;
  }
  if (!prompts.interactive) throw new UsageError(`strats config auto-buyback ${value} asks a question and needs a terminal.`);
  if (next) {
    let open = true;
    try {
      open = fileJournal(bot.id).load() !== null;
    } catch {
      // A record that cannot be read counts as a buyback that is part-way.
    }
    if (open) {
      console.log("A buyback is part-way on this machine. Finish it first: strats buyback --execute");
      return 1;
    }
  }
  // A droplet was given up with --force: only a person who has looked at the record may let a droplet pay again.
  const gap = next && bot.payoutRecordIncomplete
    ? "This machine's payout record may be missing what a lost droplet paid, and the droplet would split that profit again. First run strats buyback and check its \"Already split\" line. "
    : "";
  const question = next
    ? `${gap}${autoBuybackQuestion(bot)} It checks the profit once a day and buys back whenever the buyback share is at least $${MIN_USD_DEFAULT}, with the token, split and destination pinned here.`
    : sendsMasterKey({ ...bot, autoBuyback: true })
      ? "Stop buying back automatically? The next strats deploy replaces the droplet's credentials with ones that hold no wallet key."
      : "Stop buying back automatically? Buybacks are then yours to run, with strats buyback --execute.";
  const answer = (await prompts.ask(`${question} (y/N)`)).toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    console.log("Nothing was changed.");
    return 0;
  }
  const { payoutRecordIncomplete: _gap, ...rest } = bot;
  saveBot(next ? { ...rest, autoBuyback: true } : { ...bot, autoBuyback: false });
  console.log(next ? "Auto-buyback is on." : "Auto-buyback is off.");
  if (bot.deployment) console.log(`The droplet keeps the setting it was deployed with${bot.deployment.autoBuyback === true ? ", so it still buys back by itself" : ""}. To send it this one: strats deploy`);
  else if (next) console.log("It starts with the droplet: strats deploy");
  return 0;
}

export async function config(args: Args, prompts: Prompts): Promise<number> {
  const action = args.positionals[0] ?? "show";
  if (action !== "show" && action !== "accept" && action !== "publish-wallet" && action !== "auto-buyback") throw new UsageError("Use: strats config show, strats config accept, strats config publish-wallet on|off, or strats config auto-buyback on|off.");

  const session = requireKeystore(await openSession(args, prompts), "config");
  const { bot } = session;
  if (action === "publish-wallet") return publishWallet(bot, args.positionals[1]);
  if (action === "auto-buyback") return autoBuyback(bot, args.positionals[1], prompts);
  const fetched = await fetchConfigFor(bot.strategyId, session.gateway);
  if (!fetched.ok) {
    console.log(`Could not read the settings. ${fetched.message}`);
    return 1;
  }
  const server = fetched.value.config.account;
  const differences = pinnedDifferences(bot.pinned, server);

  console.log(`Server settings (version ${fetched.value.version}, updated ${fetched.value.updatedAt})`);
  for (const line of describeConfig(fetched.value)) console.log(line);
  console.log("Pinned on this machine");
  console.log(`  Token            ${bot.pinned.token.address} on ${chainName(bot.pinned.token.chainId)}`);
  console.log(`  Profit split     ${bot.pinned.split.buybackPct}% buys the token, ${bot.pinned.split.keepPct}% is kept`);
  console.log(`  Ceiling          ${bot.ceilingPct}% of the wallet per position (local only)`);
  console.log(`  Project page     ${describePublication(bot)}`);
  console.log(`  Auto-buyback     ${describeAutoBuyback(bot)}`);

  if (differences.length === 0) {
    console.log("The pinned payout settings match the server.");
    return 0;
  }
  console.log("Differences");
  for (const difference of differences) console.log(`  ${difference}`);
  if (action === "show") {
    console.log("The pinned values stay in force. To adopt the server's values, run: strats config accept");
    return 0;
  }

  if (!(await prompts.confirm("Replace the pinned token and split with the server's values?", false))) {
    console.log("Nothing was changed.");
    return 0;
  }
  // A destination pinned with strats buyback --to is not a server setting, so it stays.
  saveBot({ ...bot, pinned: { ...bot.pinned, token: server.token, split: server.split } });
  console.log("Pinned the server's token and split.");
  return 0;
}
