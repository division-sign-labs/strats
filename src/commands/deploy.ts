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
import { ensureDigitalOceanReady, publicIpv4, type Droplet } from "../deploy/digitalocean.js";
import { remoteWriteCommand } from "../deploy/remote-write.js";
import { ensureKeypair, forgetHostKey, pinHostKey, restrictedChildEnv, scpTo, sshExec, sshExecOrThrow, type Target } from "../deploy/ssh.js";
import { ensureHome } from "../paths.js";
import { pushPayoutSummary } from "../payouts.js";
import { RUNTIME_CREDS_ENV, buildRuntimeCreds, encodeRuntimeCreds } from "../runtime-creds.js";
import { loadAgentKey, loadPolymarketCreds, openSession, requireKeystore, runtimeCredsPresent, type KeystoreSession } from "../session.js";
import type { Prompts } from "../setup.js";
import { isPolymarketBot, isTwoVenueBot, loadBot, resolveBotId, saveBot, type BotState } from "../state.js";
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

/** What the droplet receives, in plain words. Shown before anything is created. */
export function disclosure(bot: BotState): string[] {
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
  const bot = open?.bot ?? loadBot(resolveBotId(args.values.id));
  const version = packageVersion();
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
  const creds = encodeRuntimeCreds(buildRuntimeCreds({
    apiKey: session.gateway.apiKey,
    gatewayUrl: session.gateway.gatewayUrl,
    bot,
    ...(isPolymarketBot(bot) ? {} : { hyperliquid: { agentPk: loadAgentKey(session), masterAddress: bot.masterAddress } }),
    ...(isPolymarketBot(bot) || isTwoVenueBot(bot) ? { polymarket: loadPolymarketCreds(session) } : {}),
  }));

  const { publicKey } = ensureKeypair();
  const sshKeyId = await client.upsertSshKey("strats", publicKey);

  let droplet: Droplet;
  if (reuse) {
    droplet = existing!;
  } else {
    // Replace rather than run two of the same bot against one wallet.
    for (const old of new Map(stale.map((d) => [d.id, d])).values()) {
      const oldHost = publicIpv4(old);
      if (oldHost) sshExec({ host: oldHost, user: "root" }, `systemctl stop ${unitName(bot.id)}`, undefined, { timeoutMs: 30_000 });
      await client.deleteDroplet(old.id).catch(() => undefined);
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
  let saved: BotState = { ...bot, deployment: { dropletId: droplet.id, host, region: droplet.region.slug, size: droplet.size_slug, version, deployedAt: new Date().toISOString(), pending: true } };
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
  // The only place the credentials travel: ssh stdin, into a file only the service user can read.
  writeRemote(target, envPath(bot.id), `${RUNTIME_CREDS_ENV}=${creds}\n`, "0600", "strats:strats");
  console.log("Credentials installed.");
  sshExecOrThrow(target, `systemctl daemon-reload && systemctl enable ${unitName(bot.id)} && systemctl restart ${unitName(bot.id)}`);
  await waitFor("Starting the runner", 3_000, 30, () => (sshExec(target, `systemctl is-active --quiet ${unitName(bot.id)}`, undefined, { timeoutMs: 20_000 }).ok ? true : null));

  const { pending: _pending, ...confirmed } = saved.deployment!;
  saved = { ...saved, deployment: { ...confirmed, deployedAt: new Date().toISOString() } };
  saveBot(saved);
  // The buyback totals for the public report: two numbers and a list of dates, no secret. Best effort, and it never fails the deploy.
  const payouts = pushPayoutSummary(saved);
  if (!payouts.pushed && payouts.reason === "failed") console.log("The droplet was not told about earlier buybacks, so the public totals will lag. To send them: strats buyback --sync");
  console.log("");
  console.log(`The runner is active on ${host} (${regionLabel(droplet.region.slug)}, ${droplet.size_slug}).`);
  console.log(`Cost: $${droplet.size?.price_monthly ?? SIZE_MONTHLY_USD[size] ?? "?"} per month, billed by DigitalOcean until you run strats destroy.`);
  const tail = sshExec(target, `journalctl -u ${unitName(bot.id)} -n 5 --no-pager -o cat`, undefined, { timeoutMs: 20_000 });
  if (tail.ok && tail.stdout.trim()) console.log(tail.stdout.trim());
  console.log("");
  for (const line of watchLines(saved)) console.log(line);
  return 0;
}
