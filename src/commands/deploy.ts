// strats deploy: put the runner on a DigitalOcean droplet so it runs unattended.
// The orchestration follows classy-cassie packages/cli/src/commands/deploy.ts:
// find a token, make an ssh key, create the droplet with cloud-init that holds
// no secrets, firewall to port 22, pin the host key, wait for first boot, push
// the credentials over ssh stdin into a 0600 file, start the systemd unit, and
// poll until it is active. strats init runs the same code as its last step.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Args } from "../args.js";
import {
  DEFAULT_REGION, DEFAULT_SIZE, DROPLET_IMAGE, READY_MARKER, RUNNER_PACKAGE, SIZE_MONTHLY_USD, UNIT_PATH,
  envPath, installRunnerCommand, installTarballCommand, renderCloudInit, renderUnit,
} from "../deploy/cloud-init.js";
import { AUTO_BUYBACK_UNAVAILABLE } from "../buyback/text.js";
import { DigitalOceanError, ensureDigitalOceanReady, publicIpv4, type Droplet } from "../deploy/digitalocean.js";
import { remoteWriteCommand } from "../deploy/remote-write.js";
import { ensureKeypair, forgetHostKey, pinHostKey, restrictedChildEnv, scpTo, sshExec, sshExecOrThrow, type Target } from "../deploy/ssh.js";
import { pullRecord, pushBasis } from "../buyback/droplet.js";
import { fileJournal } from "../buyback/journal.js";
import { ensureHome } from "../paths.js";
import { pushPayoutSummary } from "../payouts.js";
import { RUNTIME_CREDS_ENV, buildRuntimeCreds, encodeRuntimeCreds, type RuntimeCredsDoc } from "../runtime-creds.js";
import { loadAgentKey, loadPolymarketCreds, loadWalletKey, openSession, requireKeystore, runtimeCredsPresent, type KeystoreSession } from "../session.js";
import type { Prompts } from "../setup.js";
import { autoBuybackAvailable, isPolymarketBot, isTwoVenueBot, loadBot, resolveBotId, saveBot, sendsMasterKey, withoutDropletRecord, type BotState } from "../state.js";
import { packageRoot, packageVersion } from "../version.js";

/** Polymarket refuses orders from the United States, so a bot that trades there is never placed there. */
export const US_REGION_SLUGS = ["nyc1", "nyc2", "nyc3", "sfo1", "sfo2", "sfo3", "atl1"];

/** Plain names for the regions people pick. Any other slug is shown as it is. */
const REGION_NAMES: Record<string, string> = {
  blr1: "Bangalore", sgp1: "Singapore", syd1: "Sydney", fra1: "Frankfurt", ams3: "Amsterdam", lon1: "London", tor1: "Toronto",
  nyc1: "New York", nyc2: "New York", nyc3: "New York", sfo2: "San Francisco", sfo3: "San Francisco", atl1: "Atlanta",
};
export const regionLabel = (slug: string): string => (REGION_NAMES[slug] ? `${slug} (${REGION_NAMES[slug]})` : slug);

export const PROJECTS_URL = "https://tokenstrats.xyz/projects";

const STRATEGY_DESCRIPTIONS: Record<BotState["strategyId"], string> = {
  "stock-ls": "single asset, on Hyperliquid",
  theme: "your own theme, on Polymarket",
  team: "back a team, on Polymarket",
};

/** How to watch a deployed bot. Printed by deploy, and so by init. */
export function watchLines(bot: BotState): string[] {
  return [
    "Watch it",
    "  strats status    the wallet, positions, targets and the runner's last lines",
    "  strats logs      the runner's log; add --follow to keep reading",
    `  ${PROJECTS_URL}    the public project page. The runner's first report arrives within a few minutes.`,
    bot.publishWallet === true
      ? "  The wallet address is published with each report, as you chose. To stop: strats config publish-wallet off, then strats deploy."
      : "  The wallet address is not published. The page shows the totals, positions and trades the runner reports.",
    "To stop paying for the droplet: strats destroy",
  ];
}

export const dropletName = (botId: string): string => `strats-${botId}`;
export const unitName = (botId: string): string => `strats@${botId}`;

export function monthlyCost(size: string): string {
  const price = SIZE_MONTHLY_USD[size];
  return price === undefined ? "see DigitalOcean's price list for this size" : `$${price} per month, billed by DigitalOcean to your account`;
}

/** What the droplet receives, in plain words. Shown before anything is created. With auto-buyback off it is word for word what it was before 0.5.0. */
export function disclosure(bot: BotState): string[] {
  const lines = tradingDisclosure(bot);
  if (bot.autoBuyback !== true) return lines;
  if (!sendsMasterKey(bot)) {
    // A theme or team bot: the wallet key is already among the lines above.
    return [...lines, "Auto-buyback is on: once a day the droplet withdraws the buyback share of the profit and swaps it for your token, with the wallet key it already holds. Nothing more is sent for it."];
  }
  return [
    lines[0]!.replace(/\.$/, "; the wallet's master key, because auto-buyback is on."),
    "Auto-buyback is on, so the droplet holds the wallet's master key and can withdraw: whoever controls the droplet controls the funds in this Hyperliquid account and wallet. To keep that key on this machine: strats config auto-buyback off",
    ...lines.slice(1, -1),
    "The keystore file and its passphrase stay on this machine.",
  ];
}

function tradingDisclosure(bot: BotState): string[] {
  const common = ["the API key", `this bot's settings file, which holds addresses, percentages and your choice about publishing the wallet (${bot.publishWallet === true ? "published" : "not published"}), and nothing secret`];
  if (isTwoVenueBot(bot)) {
    return [
      `Sent to the droplet over ssh: ${common.join("; ")}; the Hyperliquid trading key, which can place orders and cannot withdraw; the Polymarket signer key and its API credentials.`,
      "The droplet holds the Polymarket signer key. Polymarket signs every order with it, so there is no trading-only key to send instead. Whoever controls the droplet controls the funds in this Polymarket wallet. Keep only what the bot needs in it.",
      "The Hyperliquid wallet's master key, the keystore file and its passphrase stay on this machine.",
    ];
  }
  if (isPolymarketBot(bot)) {
    return [
      `Sent to the droplet over ssh: ${common.join("; ")}; the Polymarket wallet key and its API credentials.`,
      "Polymarket signs every order with the wallet's own key, so there is no trading-only key to send instead. Whoever controls the droplet controls the funds in this Polymarket wallet. Keep only what the bot needs in it.",
      "The keystore file and its passphrase stay on this machine.",
    ];
  }
  return [
    `Sent to the droplet over ssh: ${common.join("; ")}; the Hyperliquid trading key, which can place orders and cannot withdraw.`,
    "The wallet's master key, the keystore file and its passphrase stay on this machine.",
  ];
}

function readiness(bot: BotState): string | null {
  if ((isPolymarketBot(bot) || isTwoVenueBot(bot)) && !bot.polymarket) return "This bot has no Polymarket account yet. Run: strats init";
  if (isPolymarketBot(bot)) return null;
  return bot.agentAddress ? null : "This bot has no approved trading key yet. Run: strats fund";
}

/** Dot progress for the waits that take minutes. */
async function waitFor<T>(label: string, intervalMs: number, attempts: number, check: () => Promise<T | null> | T | null): Promise<T> {
  process.stdout.write(label);
  for (let i = 0; i < attempts; i++) {
    let result: T | null = null;
    try {
      result = await check();
    } catch {
      result = null;
    }
    if (result !== null) {
      console.log(" done");
      return result;
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  console.log("");
  throw new Error(`Timed out: ${label}`);
}

/** True when this exact version can be installed from npm. Any failure counts as "not published". */
export function publishedOnNpm(version: string): boolean {
  const result = spawnSync("npm", ["view", `${RUNNER_PACKAGE}@${version}`, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: restrictedChildEnv(["NPM_CONFIG_"]), timeout: 25_000 });
  return result.status === 0 && (result.stdout ?? "").trim() === version;
}

/** Pack the files this program is running from. Scripts are skipped so the running dist is never rebuilt underneath us. */
function packTarball(): { path: string; cleanup: () => void } {
  const root = packageRoot();
  if (!existsSync(join(root, "dist", "cli.js"))) throw new Error("Cannot pack the runner: dist/cli.js is missing. Run npm run build first.");
  const dir = mkdtempSync(join(tmpdir(), "strats-pack-"));
  const result = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", dir], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: restrictedChildEnv(["NPM_CONFIG_"]), timeout: 120_000 });
  const name = (result.stdout ?? "").trim().split("\n").pop() ?? "";
  if (result.status !== 0 || !name.endsWith(".tgz")) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`npm pack failed: ${(result.stderr || "").trim().slice(0, 300)}`);
  }
  return { path: join(dir, basename(name)), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeRemote(target: Target, path: string, content: string, mode: string, owner: string): void {
  sshExecOrThrow(target, remoteWriteCommand(path, mode, owner), content);
}

function printPlan(bot: BotState, region: string, size: string, version: string, source: string): void {
  console.log(`Deploy bot "${bot.id}" (${isTwoVenueBot(bot) ? "single asset, on Hyperliquid and Polymarket" : STRATEGY_DESCRIPTIONS[bot.strategyId]})`);
  console.log(`  Droplet          ${dropletName(bot.id)}, ${DROPLET_IMAGE}`);
  console.log(`  Region           ${regionLabel(region)}`);
  console.log(`  Size             ${size}, ${monthlyCost(size)}`);
  console.log(`  Runner           ${RUNNER_PACKAGE}@${version}, ${source}`);
  console.log(`  Runs as          systemd unit ${unitName(bot.id)}, restarted if it stops: strats run --id ${bot.id}`);
  console.log("  Firewall         inbound ssh (port 22) only");
  console.log(`  Credentials      ${envPath(bot.id)}, mode 0600, written over ssh. The cloud-init user data holds no secrets.`);
  for (const line of disclosure(bot)) console.log(`  ${line}`);
}

/** A record that cannot be read counts as open: what was sent is not known. */
function localBuybackOpen(botId: string): boolean {
  try {
    return fileJournal(botId).load() !== null;
  } catch {
    return true;
  }
}

/**
 * Everything the droplet is sent, read from the keystore. The wallet's master key is read only when the bot file says
 * autoBuyback and the money is on Hyperliquid. With auto-buyback off it is never read, so it cannot be sent.
 */
export function runtimeCredsFor(session: KeystoreSession, bot: BotState = session.bot): RuntimeCredsDoc {
  let buybackMasterPk: string | undefined;
  if (sendsMasterKey(bot)) {
    buybackMasterPk = loadWalletKey(session) ?? undefined;
    if (!buybackMasterPk) throw new Error("Auto-buyback is on, and the keystore has no wallet key to send.");
  }
  // A two-venue bot's Polymarket arm is optional: without it the droplet runs the perp only. A theme or team bot cannot run without it.
  let polymarket: ReturnType<typeof loadPolymarketCreds> | undefined;
  if (isPolymarketBot(bot)) polymarket = loadPolymarketCreds(session);
  else if (isTwoVenueBot(bot)) {
    try {
      polymarket = loadPolymarketCreds(session);
    } catch (error) {
      console.log(`The Polymarket credentials could not be read (${error instanceof Error ? error.message.slice(0, 160) : "unknown error"}). The droplet will run the perp only. To fix: strats init`);
    }
  }
  return buildRuntimeCreds({
    apiKey: session.gateway.apiKey,
    gatewayUrl: session.gateway.gatewayUrl,
    bot,
    ...(isPolymarketBot(bot) ? {} : { hyperliquid: { agentPk: loadAgentKey(session), masterAddress: bot.masterAddress } }),
    ...(polymarket ? { polymarket } : {}),
    ...(buybackMasterPk ? { buybackMasterPk } : {}),
  });
}

/**
 * Bring home what a droplet that bought back by itself recorded. When it keeps buying back on the same droplet, its lines are copied
 * and nothing else changes. Otherwise its runner is stopped first, so nothing is written while it is read, and a buyback that is
 * part-way moves to this machine, where strats buyback --execute finishes it. Returns 0 to go on, 1 when the deploy must not,
 * and 2 to go on without the record (--force): the caller then turns auto-buyback off.
 */
function takeBackRecord(bot: BotState, opts: { keepsBuyingBack: boolean; sameDroplet: boolean; force: boolean }): number {
  const target: Target = { host: bot.deployment!.host, user: "root" };
  if (opts.keepsBuyingBack) {
    const pulled = pullRecord(bot, { moveJournal: false });
    if (!pulled.ok) console.log(`The droplet's payout record could not be copied to this machine (${pulled.message}). It stays on the droplet, which keeps using it.`);
    return 0;
  }
  sshExec(target, `systemctl stop ${unitName(bot.id)}`, undefined, { timeoutMs: 45_000 });
  const restart = (): void => void sshExec(target, `systemctl start ${unitName(bot.id)}`, undefined, { timeoutMs: 45_000 });
  // A droplet that is being replaced cannot hand over a buyback that is part-way and then be deleted half-way through a deploy that may fail.
  const pulled = pullRecord(bot, { moveJournal: opts.sameDroplet });
  if (!pulled.ok) {
    if (opts.force) {
      console.log(`The droplet's payout record could not be read (${pulled.message}). Going on because of --force. What that droplet paid out is missing from this machine's record, so auto-buyback is turned off: the new droplet does not buy back. Check the "Already split" line of strats buyback before you say yes to one.`);
      return 2;
    }
    restart();
    console.log(`The droplet's payout record could not be read (${pulled.message}). It is the only copy of what the droplet paid out, so nothing was replaced. Try again. If that droplet is gone for good, add --force.`);
    return 1;
  }
  if (pulled.journal === "left") {
    restart();
    console.log("The droplet is part-way through a buyback, and this deploy would delete it. Let it finish, or turn auto-buyback off (strats config auto-buyback off), run strats deploy with the same region and size, and finish it here with strats buyback --execute.");
    return 1;
  }
  console.log(`The droplet's payout record is on this machine now${pulled.added > 0 ? ` (${pulled.added} new line${pulled.added === 1 ? "" : "s"})` : ""}.${pulled.journal === "moved" ? " A buyback that was part-way moved here too. When this deploy is done, finish it with: strats buyback --execute" : ""}`);
  return 0;
}

export async function deploy(args: Args, prompts: Prompts): Promise<number> {
  return deployBot(args, prompts);
}

/** The deploy itself. `open` is a session that is already open, so strats init does not ask for the passphrase twice. */
export async function deployBot(args: Args, prompts: Prompts, open?: KeystoreSession): Promise<number> {
  if (runtimeCredsPresent()) throw new Error("strats deploy runs on your own machine, not on the droplet.");
  ensureHome();
  const region = args.values.region ?? DEFAULT_REGION;
  const size = args.values.size ?? DEFAULT_SIZE;
  if (!/^[a-z0-9-]{2,40}$/.test(region) || !/^[a-z0-9-]{2,60}$/.test(size)) throw new Error("--region and --size take DigitalOcean slugs such as blr1 and s-1vcpu-1gb.");
  let bot = open?.bot ?? loadBot(resolveBotId(args.values.id));
  const version = packageVersion();
  if (bot.autoBuyback === true && !autoBuybackAvailable(bot)) {
    // Set by 0.5.0. A droplet cannot tell a Polymarket deposit from profit, so it is never deployed buying back.
    bot = { ...bot, autoBuyback: false };
    if (!args.flags.has("dry-run")) saveBot(bot);
    console.log(`${AUTO_BUYBACK_UNAVAILABLE} It is now off.`);
  }
  if ((isPolymarketBot(bot) || isTwoVenueBot(bot)) && US_REGION_SLUGS.includes(region)) {
    throw new Error(`Polymarket refuses orders from the United States, and ${region} is a US region. Choose another, for example --region ${DEFAULT_REGION}.`);
  }

  if (args.flags.has("dry-run")) {
    const tarball = args.flags.has("from-tarball");
    printPlan(bot, region, size, version, tarball ? "from a local tarball" : "from npm if this version is published there, otherwise from a local tarball");
    const problem = readiness(bot);
    if (problem) console.log(`  Not ready        ${problem}`);
    console.log("");
    console.log(`Credentials file: one line, ${RUNTIME_CREDS_ENV}=<value>. It is built only on a real deploy; a dry run never opens the keystore.`);
    console.log("");
    console.log("Cloud-init user data (no secrets):");
    console.log(renderCloudInit({ runnerVersion: version, ...(tarball ? { tarball: true } : {}) }));
    console.log("Dry run. DigitalOcean was not called and nothing was created.");
    return 0;
  }

  const problem = readiness(bot);
  if (problem) {
    console.log(problem);
    return 1;
  }
  if (bot.autoBuyback === true && localBuybackOpen(bot.id)) {
    console.log("A buyback is part-way on this machine, and once the droplet buys back by itself it cannot be finished from here. Finish it first: strats config auto-buyback off, then strats buyback --execute, then turn auto-buyback on again.");
    return 1;
  }
  // Settle the DigitalOcean account before asking for the keystore passphrase.
  const { client } = await ensureDigitalOceanReady(prompts);
  const useTarball = args.flags.has("from-tarball") || !publishedOnNpm(version);
  console.log("");
  printPlan(bot, region, size, version, useTarball ? "copied from this machine as a tarball" : "installed from npm");

  const name = dropletName(bot.id);
  const existing = bot.deployment ? await client.droplet(bot.deployment.dropletId).catch(() => null) : null;
  const reuse = existing !== null && existing.region.slug === region && existing.size_slug === size;
  const namedExisting = reuse ? null : await client.dropletByName(name);
  const stale = [existing, namedExisting].filter((d): d is Droplet => d !== null && !reuse);
  if (reuse) console.log(`  Existing droplet ${publicIpv4(existing!) ?? existing!.id} is reused: the runner and its credentials are replaced and the unit restarts.`);
  else if (stale.length > 0) console.log(`  The current droplet ${stale.map((d) => d.name).join(", ")} is deleted and replaced.`);
  console.log("");
  if (!args.flags.has("yes") && !(await prompts.confirm(reuse ? "Redeploy to this droplet?" : "Create this droplet?", false))) {
    console.log("Nothing was created.");
    return 0;
  }

  const session = open ?? requireKeystore(await openSession(args, prompts), "deploy");
  prompts.close();
  // A droplet that bought back by itself holds the only copy of what it paid out. It comes back to this machine before anything there is replaced.
  const wasAuto = bot.deployment?.autoBuyback === true;
  if (wasAuto) {
    const took = takeBackRecord(bot, { keepsBuyingBack: reuse && bot.autoBuyback === true, sameDroplet: reuse, force: args.flags.has("force") });
    if (took === 1) return 1;
    // The record was given up. Paying from a stale record with nobody watching would split the same profit twice, so this deploy does not buy back.
    if (took === 2) {
      bot = withoutDropletRecord(bot, new Date().toISOString());
      saveBot(bot);
    }
  }
  const auto = bot.autoBuyback === true;
  // Built after the step above, so a deploy that turned auto-buyback off never reads or sends the wallet key.
  const creds = encodeRuntimeCreds(runtimeCredsFor(session, bot));

  const { publicKey } = ensureKeypair();
  const sshKeyId = await client.upsertSshKey("strats", publicKey);

  let droplet: Droplet;
  if (reuse) {
    droplet = existing!;
  } else {
    // Replace rather than run two of the same bot against one wallet.
    for (const old of new Map(stale.map((d) => [d.id, d])).values()) {
      const oldHost = publicIpv4(old);
      // Disabled and without its credentials first, so a droplet that survives the delete holds no key and cannot start again.
      if (oldHost) sshExec({ host: oldHost, user: "root" }, `systemctl disable --now ${unitName(bot.id)}; rm -f ${envPath(bot.id)}`, undefined, { timeoutMs: 30_000 });
      try {
        await client.deleteDroplet(old.id);
      } catch (error) {
        // Already gone is fine. Anything else would leave two runners on one wallet, so nothing new is created.
        if (!(error instanceof DigitalOceanError) || error.status !== 404) throw new Error(`The old droplet ${old.name} could not be deleted (${error instanceof Error ? error.message.slice(0, 160) : "unknown error"}), so no new one was created. Its runner is stopped. Try again, or delete it in DigitalOcean first.`);
      }
      if (oldHost) forgetHostKey(oldHost);
    }
    const created = await client.createDroplet({
      name, region, size, image: DROPLET_IMAGE, sshKeyIds: [sshKeyId],
      userData: renderCloudInit({ runnerVersion: version, ...(useTarball ? { tarball: true } : {}) }),
      tags: ["strats", `strats-bot-${bot.id}`],
    });
    droplet = await waitFor("Creating the droplet", 5_000, 120, async () => {
      const current = await client.droplet(created.id);
      return current.status === "active" && publicIpv4(current) ? current : null;
    });
  }
  const host = publicIpv4(droplet);
  if (!host) throw new Error("The droplet came up without a public IPv4 address.");
  // Record it at once, so a later failure still leaves `strats destroy` able to find the droplet.
  // `pending` stays until the runner is confirmed active, so a deploy stopped halfway is finished by strats deploy or strats init, not taken for done.
  // Until the new credentials are in place the droplet may still hold the old ones, so it counts as buying back if it did before.
  let saved: BotState = { ...bot, deployment: { dropletId: droplet.id, host, region: droplet.region.slug, size: droplet.size_slug, version, deployedAt: new Date().toISOString(), pending: true, ...(auto || wasAuto ? { autoBuyback: true } : {}) } };
  saveBot(saved);

  await client.upsertFirewall(name, droplet.id).catch((error: unknown) => {
    console.log(`The DigitalOcean firewall was not applied (${error instanceof Error ? error.message.slice(0, 160) : "unknown error"}). The droplet's own firewall still allows ssh only.`);
  });

  const target: Target = { host, user: "root" };
  // A droplet from a deploy that was stopped halfway may not have its host key pinned or its first boot finished. Both checks are safe to repeat.
  const firstBoot = !reuse || bot.deployment?.pending === true;
  if (firstBoot) {
    console.log("Reading the host key.");
    await pinHostKey(host);
  }
  await waitFor("Waiting for ssh", 5_000, 60, () => (sshExec(target, "true", undefined, { timeoutMs: 20_000 }).ok ? true : null));
  if (firstBoot) {
    await waitFor("Running first-boot setup (a few minutes)", 10_000, 90, () => (sshExec(target, `test -f ${READY_MARKER} && command -v node >/dev/null`, undefined, { timeoutMs: 20_000 }).ok ? true : null));
  }

  const installed = sshExec(target, "strats --version 2>/dev/null || true", undefined, { timeoutMs: 30_000 }).stdout.trim();
  if (useTarball || installed !== version) {
    if (useTarball) {
      const tarball = packTarball();
      try {
        const remote = `/tmp/${basename(tarball.path)}`;
        console.log("Copying the runner to the droplet.");
        scpTo(target, tarball.path, remote);
        console.log("Installing the runner.");
        sshExecOrThrow(target, `${installTarballCommand(remote)} && rm -f ${remote}`, undefined, { timeoutMs: 600_000 });
      } finally {
        tarball.cleanup();
      }
    } else {
      console.log("Installing the runner.");
      sshExecOrThrow(target, installRunnerCommand(version), undefined, { timeoutMs: 600_000 });
    }
    const now = sshExec(target, "strats --version", undefined, { timeoutMs: 30_000 }).stdout.trim();
    if (now !== version) throw new Error(`The droplet reports runner version "${now || "none"}", expected ${version}.`);
  }

  writeRemote(target, UNIT_PATH, renderUnit(version), "0644", "root:root");
  if (auto) {
    // Before the key: the payout record and the deposits figure the droplet measures profit from. No secret. Without it the droplet pays nothing.
    const sent = pushBasis(saved);
    if (!sent.ok) throw new Error(`The droplet was not sent the payout record its automatic buyback measures profit from (${sent.message}). The credentials were not replaced. Run strats deploy again.`);
  }
  // The only place the credentials travel: ssh stdin, into a file only the service user can read.
  writeRemote(target, envPath(bot.id), `${RUNTIME_CREDS_ENV}=${creds}\n`, "0600", "strats:strats");
  console.log("Credentials installed.");
  sshExecOrThrow(target, `systemctl daemon-reload && systemctl enable ${unitName(bot.id)} && systemctl restart ${unitName(bot.id)}`);
  await waitFor("Starting the runner", 3_000, 30, () => (sshExec(target, `systemctl is-active --quiet ${unitName(bot.id)}`, undefined, { timeoutMs: 20_000 }).ok ? true : null));

  // From here the droplet holds exactly what this deploy sent, so the record says what it was sent.
  const { pending: _pending, autoBuyback: _before, ...confirmed } = saved.deployment!;
  saved = { ...saved, deployment: { ...confirmed, deployedAt: new Date().toISOString(), ...(auto ? { autoBuyback: true } : {}) } };
  saveBot(saved);
  if (auto) {
    console.log("Auto-buyback is on. The droplet checks the profit once a day, first 10 minutes after its first start, and keeps the payout record. strats buyback --execute is refused on this machine meanwhile.");
  } else {
    // The buyback totals for the public report: two numbers and a list of dates, no secret. Best effort, and it never fails the deploy.
    const payouts = pushPayoutSummary(saved);
    if (!payouts.pushed && payouts.reason === "failed") console.log("The droplet was not told about earlier buybacks, so the public totals will lag. To send them: strats buyback --sync");
  }
  console.log("");
  console.log(`The runner is active on ${host} (${regionLabel(droplet.region.slug)}, ${droplet.size_slug}).`);
  console.log(`Cost: $${droplet.size?.price_monthly ?? SIZE_MONTHLY_USD[size] ?? "?"} per month, billed by DigitalOcean until you run strats destroy.`);
  const tail = sshExec(target, `journalctl -u ${unitName(bot.id)} -n 5 --no-pager -o cat`, undefined, { timeoutMs: 20_000 });
  if (tail.ok && tail.stdout.trim()) console.log(tail.stdout.trim());
  console.log("");
  for (const line of watchLines(saved)) console.log(line);
  return 0;
}
