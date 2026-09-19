// strats config [show|accept]: compare the server's settings with the pinned payout settings, and re-pin on request.
import { UsageError, type Args } from "../args.js";
import { fetchConfig, fetchThemeConfig } from "../client.js";
import { openSession, requireKeystore } from "../session.js";
import type { Prompts } from "../setup.js";
import { pinnedDifferences, saveBot } from "../state.js";
import { chainName, describeConfig } from "./init.js";

export async function config(args: Args, prompts: Prompts): Promise<number> {
  const action = args.positionals[0] ?? "show";
  if (action !== "show" && action !== "accept") throw new UsageError("Use: strats config show, or strats config accept.");

  const session = requireKeystore(await openSession(args, prompts), "config");
  const { bot } = session;
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
