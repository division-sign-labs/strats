// strats logs: the deployed runner's journal over ssh, or the local log file.
import { existsSync, readFileSync } from "node:fs";
import { UsageError, type Args } from "../args.js";
import { sshExec, sshInteractive } from "../deploy/ssh.js";
import { ensureHome, logFile } from "../paths.js";
import type { Prompts } from "../setup.js";
import { loadBot, resolveBotId } from "../state.js";
import { unitName } from "./deploy.js";

export async function logs(args: Args, prompts: Prompts): Promise<number> {
  ensureHome();
  prompts.close();
  const bot = loadBot(resolveBotId(args.values.id));
  const lines = Number(args.values.lines ?? 50);
  if (!Number.isInteger(lines) || lines < 1 || lines > 5000) throw new UsageError("--lines is a whole number from 1 to 5000.");

  if (!bot.deployment) {
    const path = logFile(bot.id);
    if (!existsSync(path)) {
      console.log(`Bot "${bot.id}" is not deployed and has no local log yet.`);
      return 0;
    }
    console.log(readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n"));
    return 0;
  }
  const target = { host: bot.deployment.host, user: "root" };
  const command = `journalctl -u ${unitName(bot.id)} -n ${lines} --no-pager -o short-iso`;
  if (args.flags.has("follow")) return sshInteractive(target, `${command} -f`);
  const result = sshExec(target, command, undefined, { timeoutMs: 30_000 });
  if (!result.ok) {
    console.log(`Could not read the logs from ${target.host}. ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
    return 1;
  }
  console.log(result.stdout.trimEnd());
  return 0;
}
