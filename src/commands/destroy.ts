// strats destroy: stop the runner, delete the droplet and its firewall. Positions are not touched.
import type { Args } from "../args.js";
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
