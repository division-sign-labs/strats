// strats destroy: stop the runner, delete the droplet and its firewall. Positions are not touched.
import type { Args } from "../args.js";
import { pullRecord } from "../buyback/droplet.js";
import { DigitalOceanError, ensureDigitalOceanReady } from "../deploy/digitalocean.js";
import { forgetHostKey, sshExec } from "../deploy/ssh.js";
import { ensureHome } from "../paths.js";
import type { Prompts } from "../setup.js";
import { loadBot, resolveBotId, saveBot } from "../state.js";
import { dropletName, unitName } from "./deploy.js";

export async function destroy(args: Args, prompts: Prompts): Promise<number> {
  ensureHome();
  const bot = loadBot(resolveBotId(args.values.id));
  if (!bot.deployment) {
    console.log(`Bot "${bot.id}" is not deployed. Nothing to destroy.`);
    return 0;
  }
  const { dropletId, host } = bot.deployment;
  console.log(`This stops the runner on ${host} and deletes droplet ${dropletName(bot.id)} and its firewall.`);
  console.log("Open positions and resting orders stay on the venue exactly as they are. Nothing is closed.");
  if (!args.flags.has("yes") && !(await prompts.confirm("Delete the droplet?", false))) {
    console.log("Nothing was changed.");
    return 0;
  }
  const { client } = await ensureDigitalOceanReady(prompts);
  prompts.close();
  sshExec({ host, user: "root" }, `systemctl stop ${unitName(bot.id)}`, undefined, { timeoutMs: 45_000 });
  if (bot.deployment.autoBuyback === true) {
    // This droplet bought back by itself, so it holds the only copy of what it paid out. That comes home before the droplet goes.
    const pulled = pullRecord(bot, { moveJournal: true });
    if (!pulled.ok && !args.flags.has("force")) {
      sshExec({ host, user: "root" }, `systemctl start ${unitName(bot.id)}`, undefined, { timeoutMs: 45_000 });
      console.log(`The droplet's payout record could not be read (${pulled.message}). It is the only copy of what the droplet paid out, so nothing was deleted. Try again. If the droplet is gone for good, add --force.`);
      return 1;
    }
    if (!pulled.ok) console.log(`The droplet's payout record could not be read (${pulled.message}). Going on because of --force. What it paid out is missing from this machine's record: check the "Already split" line of strats buyback before you say yes to one.`);
    else console.log(`The droplet's payout record is on this machine now.${pulled.journal === "moved" ? " A buyback that was part-way moved here too. To finish it: strats buyback --execute" : ""}`);
  }
  try {
    await client.deleteDroplet(dropletId);
  } catch (error) {
    // Already gone is the outcome we wanted.
    if (!(error instanceof DigitalOceanError) || error.status !== 404) throw error;
  }
  await client.deleteFirewall(dropletName(bot.id)).catch(() => undefined);
  forgetHostKey(host);
  const { deployment: _removed, ...rest } = bot;
  saveBot(rest);
  console.log("The droplet is deleted and billing for it stops. The wallet and keystore on this machine are unchanged.");
  return 0;
}
