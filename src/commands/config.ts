// strats config [show|accept]: compare the server's settings with the pinned payout settings, and re-pin on request.
// strats config publish-wallet [on|off]: show or change whether reports carry the wallet address.
import { UsageError, type Args } from "../args.js";
import { fetchConfig, fetchThemeConfig } from "../client.js";
import { openSession, requireKeystore } from "../session.js";
import type { Prompts } from "../setup.js";
import { pinnedDifferences, saveBot, type BotState } from "../state.js";
import { chainName, describeConfig } from "./init.js";

/** The address a report would carry: the Hyperliquid wallet, or a theme bot's Polymarket deposit wallet. */
const publishableAddress = (bot: BotState): string => (bot.strategyId === "theme" ? bot.polymarket?.funder ?? "the Polymarket deposit wallet" : bot.masterAddress);

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

export async function config(args: Args, prompts: Prompts): Promise<number> {
  const action = args.positionals[0] ?? "show";
  if (action !== "show" && action !== "accept" && action !== "publish-wallet") throw new UsageError("Use: strats config show, strats config accept, or strats config publish-wallet on|off.");

  const session = requireKeystore(await openSession(args, prompts), "config");
  const { bot } = session;
  if (action === "publish-wallet") return publishWallet(bot, args.positionals[1]);
  const fetched = bot.strategyId === "theme" ? await fetchThemeConfig(session.gateway) : await fetchConfig(session.gateway);
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
  saveBot({ ...bot, pinned: { token: server.token, split: server.split } });
  console.log("Pinned the server's token and split.");
  return 0;
}
