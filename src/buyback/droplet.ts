// The creator's machine and a droplet that buys back by itself keep one payout
// record between them. Two moves, both over ssh and both safe to repeat:
//   push  the basis file: this machine's record and deposits figure, for the droplet to measure profit from;
//   pull  the droplet's record into this machine's, line by line, never twice, and on request the one
//         buyback that is part-way, so it can be finished by hand after auto-buyback is turned off.
// Nothing here is a secret, and nothing here signs or sends money.
import { RUNNER_HOME, RUNNER_OWNER } from "../deploy/cloud-init.js";
import { remoteWriteCommand } from "../deploy/remote-write.js";
import { sshExec, type ExecResult, type Target } from "../deploy/ssh.js";
import { appendLedger, parseLedger } from "../payouts.js";
import type { BotState } from "../state.js";
import { basisFileBody, buildBasis } from "./basis.js";
import { JournalSchema, fileJournal, type Journal } from "./journal.js";

export type Exec = (target: Target, command: string, stdin?: string, options?: { timeoutMs?: number }) => ExecResult;
type DeployedBot = Pick<BotState, "id" | "deployment">;

const remoteState = (botId: string, suffix: string): string => `${RUNNER_HOME}/state/${botId}.${suffix}`;
const failure = (result: ExecResult): string => (result.stderr || "ssh failed").trim().replace(/\s+/g, " ").slice(0, 200);

export type SyncResult = { ok: true } | { ok: false; message: string };

/** Send the droplet what its automatic buyback measures profit from. `hold` pauses it while a deposit is on its way. */
export function pushBasis(bot: DeployedBot, opts: { hold?: boolean } = {}, exec: Exec = sshExec): SyncResult {
  if (!bot.deployment) return { ok: false, message: "this bot is not deployed" };
  try {
    const dir = `${RUNNER_HOME}/state`;
    const [user, group] = RUNNER_OWNER.split(":");
    const command = `install -d -m 0700 -o ${user} -g ${group} ${dir} && ${remoteWriteCommand(remoteState(bot.id, "buyback-basis.json"), "0600", RUNNER_OWNER)}`;
    const result = exec({ host: bot.deployment.host, user: "root" }, command, basisFileBody(buildBasis(bot.id, opts)), { timeoutMs: 30_000 });
    return result.ok ? { ok: true } : { ok: false, message: failure(result) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message.slice(0, 200) : "unknown error" };
  }
}

export type PullResult =
  | { ok: true; added: number; journal: "none" | "left" | "moved"; stage?: Journal["stage"] }
  | { ok: false; message: string };

/**
 * Copy the droplet's payout lines into this machine's record. With `moveJournal`, a buyback that is part-way moves here too:
 * it is written to this machine first and removed from the droplet after, so it exists in one place at the end. The caller
 * stops the runner first, so the droplet is not writing while this reads.
 */
export function pullRecord(bot: DeployedBot, opts: { moveJournal: boolean }, exec: Exec = sshExec): PullResult {
  if (!bot.deployment) return { ok: false, message: "this bot is not deployed" };
  const target: Target = { host: bot.deployment.host, user: "root" };
  const read = (path: string): ExecResult => exec(target, `if [ -f '${path}' ]; then cat '${path}'; fi`, undefined, { timeoutMs: 30_000 });
  try {
    const ledger = read(remoteState(bot.id, "payouts.jsonl"));
    if (!ledger.ok) return { ok: false, message: failure(ledger) };
    const parsed = parseLedger(ledger.stdout);
    if (parsed.skipped > 0) return { ok: false, message: `${parsed.skipped} line${parsed.skipped === 1 ? "" : "s"} of the droplet's payout record could not be read` };
    let added = 0;
    for (const line of parsed.lines) if (appendLedger(bot.id, line)) added += 1;

    const remoteJournal = read(remoteState(bot.id, "buyback.json"));
    if (!remoteJournal.ok) return { ok: false, message: failure(remoteJournal) };
    if (remoteJournal.stdout.trim() === "") return { ok: true, added, journal: "none" };
    let journal: Journal;
    try {
      journal = JournalSchema.parse(JSON.parse(remoteJournal.stdout));
    } catch {
      return { ok: false, message: "the droplet's record of a buyback that is part-way could not be read" };
    }
    if (!opts.moveJournal) return { ok: true, added, journal: "left", stage: journal.stage };
    const store = fileJournal(bot.id);
    const here = store.load();
    if (here && here.id !== journal.id) return { ok: false, message: "this machine and the droplet each have a different buyback part-way. Finish the one here first: strats buyback --execute" };
    if (!here) store.create(journal);
    const removed = exec(target, `rm -f '${remoteState(bot.id, "buyback.json")}'`, undefined, { timeoutMs: 30_000 });
    if (!removed.ok) return { ok: false, message: `the part-way buyback was copied here but could not be removed from the droplet (${failure(removed)})` };
    return { ok: true, added, journal: "moved", stage: journal.stage };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message.slice(0, 200) : "unknown error" };
  }
}

/** The droplet's last buyback line, from its log. Empty when there is none or it cannot be read. */
export function lastBuybackLine(bot: DeployedBot, exec: Exec = sshExec): string {
  if (!bot.deployment) return "";
  const result = exec({ host: bot.deployment.host, user: "root" }, `journalctl -u strats@${bot.id} --since '3 days ago' --no-pager -o cat | grep -F '  buyback  ' | tail -n 1`, undefined, { timeoutMs: 30_000 });
  return result.stdout.trim().slice(0, 400);
}
