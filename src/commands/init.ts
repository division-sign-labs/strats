// src/commands/init.ts
// strats init: the whole install, in one go. Read the settings through the
// gateway, create the wallet and the keystore, pin the payout settings, fund
// the wallet, and deploy the runner to a droplet. Every stage after the first
// can be stopped and picked up again by running strats init once more; the
// wallet is never created twice. Funding and deploying are the same code that
// strats fund and strats deploy run.
import { KeyRoles, generateEoa } from "@quotient-forecasting/cassie-core";
import { UsageError, type Args } from "../args.js";
import { autoBuybackQuestion } from "../buyback/text.js";
import { DEFAULT_GATEWAY_URL, discoverConfig, fetchConfigFor, normalizeGatewayUrl } from "../client.js";
import { STAGE_NAMES, nextInitStage, type InitStage } from "../install.js";
import { DEFAULT_BOT_ID, assertBotId, ensureHome, keysDir } from "../paths.js";
import { TEAM_BET_MODES, configuredMarkets, type AnyConfigDoc } from "../protocol/index.js";
import { VENUE_MIN_NOTIONAL_USD, effectivePct } from "../reconcile.js";
import { THEME_DEFAULT_MIN_SHARES } from "../reconcile-theme.js";
import { POLYMARKET_L2_ROLE, POLYMARKET_SIGNER_ROLE, openSession, polymarketSignerRole, requireKeystore, type KeystoreSession } from "../session.js";
import { checkPassphrase, makeSetupContext, openKeystore, readPassphrase, type Prompts } from "../setup.js";
import { API_KEY_ROLE, MAX_POSITION_PCT, botExists, isPolymarketBot, isTwoVenueBot, loadBot, saveBot, type BotState } from "../state.js";
import { buildAdapter } from "../venue.js";
import { buildPolymarketAdapter } from "../venue-polymarket.js";
import { PROJECTS_URL, deployBot, watchLines } from "./deploy.js";
import { fundSession } from "./fund.js";

const CHAIN_NAMES: Record<number, string> = { 1: "Ethereum", 10: "Optimism", 137: "Polygon", 4663: "Robinhood Chain", 8453: "Base", 42161: "Arbitrum" };
export const chainName = (chainId: number): string => (CHAIN_NAMES[chainId] ? `${CHAIN_NAMES[chainId]} (chain ${chainId})` : `chain ${chainId}`);

function describeStrategy(config: AnyConfigDoc["config"]): string[] {
  if (config.strategyId === "team") {
    const { team, mode, marginPts, maxPriceCents } = config.strategy;
    const bet = TEAM_BET_MODES.find((m) => m.value === mode);
    return [
      "  Strategy         Back a team, on Polymarket",
      `  Team             ${team.name} (${team.league.toUpperCase()})`,
      `  Bet              ${bet?.label ?? mode}`,
      ...(bet?.usesMargin ? [`  Lead needed      ${marginPts} point${marginPts === 1 ? "" : "s"}`] : []),
      `  Pay at most      ${maxPriceCents}¢`,
    ];
  }
  if (config.strategyId === "theme") {
    return [
      "  Strategy         Your own theme, on Polymarket",
      `  Thesis           ${config.strategy.thesis}`,
      `  Markets          ${config.strategy.markets.length} chosen on TokenStrats`,
    ];
  }
  const markets = config.strategy.markets?.length ?? 0;
  return [
    `  Strategy         Single asset, on Hyperliquid${markets > 0 ? " and Polymarket" : ""}`,
    `  Asset            ${config.strategy.assetKey}`,
    ...(markets > 0 ? [`  Markets          ${markets} on Polymarket, chosen on TokenStrats`] : []),
  ];
}

export function describeConfig(doc: AnyConfigDoc): string[] {
  const { account } = doc.config;
  const head = describeStrategy(doc.config);
  return [
    ...head,
    `  Position size    ${account.positionPct}% of the wallet per position`,
    `  Token            ${account.token.address} on ${chainName(account.token.chainId)}`,
    `  Profit split     ${account.split.buybackPct}% buys the token, ${account.split.keepPct}% is kept`,
  ];
}

export function parseCeiling(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_POSITION_PCT) throw new UsageError(`The ceiling must be a number above 0 and at most ${MAX_POSITION_PCT}.`);
  return value;
}

function previousBot(id: string): BotState | undefined {
  try {
    return botExists(id) ? loadBot(id) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The first stage: read and show the settings, ask for the local ceiling, whether to
 * publish the wallet, and the passphrase, then create the wallet. A wallet that exists is kept.
 */
async function setup(args: Args, prompts: Prompts, id: string, gatewayUrl: string): Promise<KeystoreSession | number> {
  const keystore = openKeystore();
  // --key is convenient; STRATS_API_KEY or the prompt keep the key out of shell history.
  const apiKey = (args.values.key ?? process.env.STRATS_API_KEY ?? (await prompts.ask("API key (qsk_...)", { secret: true }))).trim();
  if (!/^qsk_[A-Za-z0-9_-]{8,}$/.test(apiKey)) throw new UsageError("The API key should start with qsk_. Copy it from TokenStrats.");

  const config = await discoverConfig({ gatewayUrl, apiKey });
  if (!config.ok) {
    console.log(`Could not read the settings. ${config.message}`);
    return 1;
  }
  const account = config.value.config.account;
  console.log("Settings saved on TokenStrats. They are read-only here.");
  for (const line of describeConfig(config.value)) console.log(line);
  console.log("");

  const ceilingDefault = Math.min(account.positionPct, MAX_POSITION_PCT);
  const ceilingPct = parseCeiling(
    args.values.ceiling ?? (await prompts.ask("Most you will ever put in one position, as % of the wallet", { default: String(ceilingDefault) })),
  );

  // Asked once. A later --force keeps the answer; strats config publish-wallet changes it.
  const earlier = previousBot(id);
  const publishWallet = earlier?.publishWallet !== undefined
    ? earlier.publishWallet
    : prompts.interactive && (await prompts.confirm("Show this bot's trades on its public project page? The wallet address becomes public.", false));
  // Asked once too, on a terminal only, and not when --no-deploy says there is no droplet. No flag answers it, and the default is no.
  // Yes is the consent the droplet's unattended buyback runs on. strats config auto-buyback changes it.
  const autoBuyback = earlier?.autoBuyback !== undefined
    ? earlier.autoBuyback
    : prompts.interactive && !args.flags.has("no-deploy")
      ? await prompts.confirm(autoBuybackQuestion({ strategyId: config.value.config.strategyId }), false)
      : undefined;

  const keystoreExists = keystore.exists(id);
  const passphrase = await readPassphrase(prompts, { create: !keystoreExists });
  // Never add entries under a second passphrase, and never replace a wallet that may hold funds.
  if (keystoreExists) checkPassphrase(keystore, id, passphrase);
  let masterAddress = keystore.entryMeta(id, KeyRoles.master)?.address;
  const keptWallet = masterAddress !== undefined;
  if (!masterAddress) {
    const wallet = generateEoa();
    keystore.putEntry(id, KeyRoles.master, wallet.privateKey, passphrase, { address: wallet.address, runtimeEligible: false });
    masterAddress = wallet.address;
  }
  keystore.putEntry(id, API_KEY_ROLE, apiKey, passphrase, { runtimeEligible: true });
  const agentAddress = keystore.entryMeta(id, KeyRoles.agent)?.address;

  const strategyId = config.value.config.strategyId;
  const previous = keptWallet ? earlier : undefined;
  if (previous && previous.strategyId !== strategyId) {
    throw new Error(`Bot "${id}" was set up for the other strategy and its wallet may hold funds there. Create a separate bot for this key with --id.`);
  }
  // A single asset with Polymarket markets is still one bot. Its Polymarket orders are signed by a key of their own,
  // so the droplet, which must hold that key, never holds the key that owns the Hyperliquid funds.
  const tradesMarkets = config.value.strategyId === "stock-ls" && configuredMarkets(config.value).length > 0;
  const markets = tradesMarkets ? previous?.markets ?? {} : previous?.markets;
  let polymarketSigner = keystore.entryMeta(id, POLYMARKET_SIGNER_ROLE)?.address;
  if (markets && !polymarketSigner) {
    const signer = generateEoa();
    keystore.putEntry(id, POLYMARKET_SIGNER_ROLE, signer.privateKey, passphrase, { address: signer.address, runtimeEligible: true });
    polymarketSigner = signer.address;
  }
  const bot: BotState = {
    v: 1,
    id,
    strategyId,
    gatewayUrl,
    keyPrefix: apiKey.slice(0, 12),
    masterAddress,
    ...(keptWallet && agentAddress ? { agentAddress } : {}),
    ...(previous?.polymarket ? { polymarket: previous.polymarket } : {}),
    ...(markets ? { markets } : {}),
    ...(previous?.deployment ? { deployment: previous.deployment } : {}),
    ...(previous?.fundedAt ? { fundedAt: previous.fundedAt } : {}),
    publishWallet,
    ...(autoBuyback !== undefined ? { autoBuyback } : {}),
    ceilingPct,
    // A destination pinned with strats buyback --to is this machine's choice, so reading the settings again keeps it.
    pinned: { token: account.token, split: account.split, ...(previous?.pinned.destination ? { destination: previous.pinned.destination } : {}) },
    // Profit is measured from the wallet's first day, so a re-init keeps the original date.
    createdAt: previous?.createdAt ?? new Date().toISOString(),
  };
  saveBot(bot);

  console.log(keptWallet ? "Kept the existing wallet." : "Wallet created.");
  console.log(isPolymarketBot(bot) ? `  Signing address  ${masterAddress} (signs orders; do not send funds here)` : `  Address          ${masterAddress}`);
  if (isTwoVenueBot(bot)) console.log(`  Polymarket key   ${polymarketSigner} (signs Polymarket orders; do not send funds here)`);
  console.log(`  Keystore         ${keysDir()} (encrypted)`);
  console.log(`  Ceiling          ${ceilingPct}% of the wallet per position`);
  console.log(`  Project page     ${publishWallet ? "shows the wallet address, as you chose" : "does not show the wallet address"}. To change it: strats config publish-wallet on|off`);
  console.log(`  Auto-buyback     ${autoBuyback === true ? "on: the droplet buys back by itself, as you chose" : "off: buybacks are yours to run, with strats buyback --execute"}. To change it: strats config auto-buyback on|off`);
  console.log(`  Payout settings  pinned from this config; a later change on the server needs "strats config accept"`);
  console.log("");
  return { bot, keystore, passphrase, gateway: { gatewayUrl, apiKey } };
}

/** Bots that trade on Polymarket: a deposit wallet owned by the bot's key, API credentials, and the trading approvals. It costs nothing. */
async function setupPolymarketAccount(session: KeystoreSession, prompts: Prompts): Promise<number> {
  const { bot, keystore, passphrase } = session;
  console.log(`Setting up the Polymarket account. This creates a deposit wallet owned by the ${isTwoVenueBot(bot) ? "Polymarket key" : "key"} above and approves trading. It costs nothing.`);
  const base = makeSetupContext(bot.id, keystore, passphrase, prompts, { masterRole: polymarketSignerRole(bot) });
  try {
    const acct = await buildPolymarketAdapter().setup({ ...base, select: async (question, choices) => (question === "Polymarket account" ? "create" : (await prompts.ask(`${question} (${choices.map((c) => c.value).join("/")})`)).trim()) });
    if (acct.venue !== "polymarket") throw new Error("the adapter returned a different venue");
    session.bot = { ...bot, polymarket: { signerAddress: acct.signerAddress, funder: acct.funder, signatureType: acct.signatureType } };
    saveBot(session.bot);
    return 0;
  } catch (error) {
    console.log(`The Polymarket account could not be set up: ${error instanceof Error ? error.message : String(error)}`);
    console.log("The wallet and settings are saved. Run strats init again to retry.");
    return 1;
  }
}

/**
 * Where to send the money and how much the bot needs. `positionPct` is null when the settings could not be read just now.
 * A two-venue bot is shown both venues at its first funding step, and Polymarket alone when only that step is left.
 */
async function printFundingInstructions(bot: BotState, positionPct: number | null, only?: "polymarket"): Promise<void> {
  const pct = positionPct === null ? null : effectivePct(positionPct, bot.ceilingPct);
  const polymarket = async (): Promise<void> => {
    console.log(`  Polymarket deposit wallet  ${bot.polymarket!.funder}`);
    try {
      const instructions = await buildPolymarketAdapter().fundingInstructions({ venue: "polymarket", ...bot.polymarket! });
      for (const entry of instructions.addresses) console.log(`  Send USDC (${entry.chain}) to ${entry.address}. Minimum ${entry.minimum} USDC.`);
    } catch {
      console.log("  The deposit address could not be read just now. It is shown again below.");
    }
    console.log(`  The smallest order Polymarket accepts is ${THEME_DEFAULT_MIN_SHARES} shares.${pct === null ? "" : ` At ${pct}% per position the wallet needs at least $${Math.ceil((THEME_DEFAULT_MIN_SHARES * 100) / pct)} to trade.`}`);
    console.log("  Polymarket refuses orders from the United States. The deploy step places the runner in a region where it can trade.");
  };
  const hyperliquid = async (): Promise<void> => {
    const funding = (await buildAdapter("").fundingInstructions({ venue: "hyperliquid", masterAddress: bot.masterAddress })).addresses[0];
    console.log(`  Send USDC on Arbitrum to ${bot.masterAddress}.`);
    console.log(`  Hyperliquid's minimum deposit is ${funding?.minimum ?? 5} USDC. A smaller deposit is lost.`);
    console.log(`  The smallest order Hyperliquid accepts is $${VENUE_MIN_NOTIONAL_USD}.${pct === null ? "" : ` At ${pct}% per position the wallet needs at least $${Math.ceil((VENUE_MIN_NOTIONAL_USD * 100) / pct)} to trade.`} Deposit somewhat more to leave room for rounding and fees.`);
    console.log("  The wallet also needs a little ETH on Arbitrum to pay for the deposit transaction.");
  };
  console.log("Fund the wallet");
  if (!isTwoVenueBot(bot)) {
    await (isPolymarketBot(bot) ? polymarket() : hyperliquid());
  } else {
    if (only !== "polymarket") {
      console.log("  Hyperliquid, for the perp. This step comes first.");
      await hyperliquid();
    }
    if (bot.polymarket) {
      console.log(`  Polymarket, for the markets.${only === "polymarket" ? "" : " This step comes second, and it can be skipped to start with the perp only."}`);
      await polymarket();
    }
  }
  console.log("");
}

/** The Polymarket funding step of a two-venue bot is optional: --perp-only skips it, and at a terminal the creator is asked. */
async function skipsPolymarketFunding(args: Args, prompts: Prompts): Promise<boolean> {
  if (args.flags.has("perp-only")) return true;
  if (!prompts.interactive) return false;
  return !(await prompts.confirm("Fund Polymarket now? Without it the bot trades the perp only.", true));
}

function sayLocalRun(bot: BotState): void {
  console.log("To run it on this machine");
  console.log("  strats run --dry-run --once    shows what it would do and sends nothing");
  console.log("  strats run                     the loop; it trades for as long as it stays open");
  if (isPolymarketBot(bot) || isTwoVenueBot(bot)) console.log("  Polymarket refuses orders from the United States. From there, use strats deploy.");
  console.log("To put it on a droplet later: strats deploy");
  console.log(`The public project page: ${PROJECTS_URL}`);
}

export async function init(args: Args, prompts: Prompts): Promise<number> {
  if (args.flags.has("dry-run")) throw new UsageError("strats init has no dry run. strats deploy --dry-run shows the deploy plan without creating anything.");
  const id = assertBotId(args.values.id ?? DEFAULT_BOT_ID);
  const gatewayUrl = normalizeGatewayUrl(args.values.gateway ?? process.env.STRATS_GATEWAY_URL ?? DEFAULT_GATEWAY_URL);
  const force = args.flags.has("force");
  const noDeploy = args.flags.has("no-deploy");
  // fund and deploy resolve the bot from --id, so the steps below always name it.
  const stepArgs: Args = { ...args, values: { ...args.values, id } };
  ensureHome();
  prompts.interruptMessage = "Stopped. What was finished is saved. To continue, run: strats init";

  const onDisk = botExists(id) ? loadBot(id) : undefined;
  const credsStored = (): boolean => openKeystore().entryMeta(id, POLYMARKET_L2_ROLE) !== null;
  let stage: InitStage = nextInitStage({ bot: onDisk, force, noDeploy, polymarketCredsStored: credsStored() });

  if (onDisk && !force) {
    const givenKey = args.values.key ?? process.env.STRATS_API_KEY;
    if (givenKey !== undefined && givenKey.trim().slice(0, 12) !== onDisk.keyPrefix) {
      console.log(`A bot named "${id}" already exists for a different key. Use --id to create another bot, or --force to replace this bot's settings (the wallet is kept).`);
      return 1;
    }
    if (stage === "done") {
      if (onDisk.deployment?.pending === true) {
        // Only reached with --no-deploy: without it a deploy that was stopped halfway is the next stage.
        console.log(`Bot "${id}" is set up and funded. Its droplet ${onDisk.deployment.host} exists, but the runner was not confirmed running. To finish: strats deploy`);
        return 0;
      }
      console.log(`Bot "${id}" is set up and funded${onDisk.deployment ? `, and deployed on ${onDisk.deployment.host} (${onDisk.deployment.region})` : ". It is not deployed"}.`);
      if (onDisk.deployment) for (const line of watchLines(onDisk)) console.log(line);
      else sayLocalRun(onDisk);
      console.log("To replace its settings, run strats init --force (the wallet is kept). To create another bot, use --id.");
      return 0;
    }
    console.log(`Bot "${id}" already has a wallet, which is kept. Continuing with ${STAGE_NAMES[stage]}.`);
  }

  let session: KeystoreSession;
  let positionPct: number | null = null;
  if (stage === "setup") {
    const made = await setup(args, prompts, id, gatewayUrl);
    if (typeof made === "number") return made;
    session = made;
  } else {
    session = requireKeystore(await openSession(stepArgs, prompts), "init");
  }

  // Each stage leaves its result in the bot file, so the next one is always read from what is true now.
  const visited = new Set<InitStage>();
  for (;;) {
    stage = nextInitStage({ bot: session.bot, noDeploy, polymarketCredsStored: credsStored() });
    if (stage === "done" || stage === "setup") break;
    if (visited.has(stage)) throw new Error(`The ${STAGE_NAMES[stage]} step did not finish. Run strats init again to retry.`);
    visited.add(stage);

    if (stage === "account") {
      const code = await setupPolymarketAccount(session, prompts);
      if (code !== 0) return code;
    } else if (stage === "fund" || stage === "fund-markets") {
      if (positionPct === null) {
        const config = await fetchConfigFor(session.bot.strategyId, session.gateway);
        if (config.ok) positionPct = config.value.config.account.positionPct;
      }
      const polymarketStep = stage === "fund-markets";
      if (polymarketStep && (await skipsPolymarketFunding(args, prompts))) {
        session.bot = { ...session.bot, markets: { ...session.bot.markets, skippedAt: new Date().toISOString() } };
        saveBot(session.bot);
        console.log("Polymarket is not funded, so the bot trades the perp only. To fund it later: strats fund --venue polymarket");
        console.log("");
        continue;
      }
      await printFundingInstructions(session.bot, positionPct, polymarketStep ? "polymarket" : undefined);
      let code = 1;
      try {
        code = await fundSession(session, stepArgs, prompts, { chained: true, ...(polymarketStep ? { venue: "polymarket" as const } : {}) });
      } catch (error) {
        console.log(`Funding did not finish: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (code !== 0) {
        console.log("The wallet and settings are saved. To continue from funding, run: strats init");
        return 1;
      }
      console.log("");
    } else {
      console.log("Deploy");
      console.log("  The last step puts the runner on a DigitalOcean droplet in your own account, so it trades without this machine. The plan and the monthly cost are shown before anything is created.");
      console.log("");
      let code = 1;
      try {
        code = await deployBot(stepArgs, prompts, session);
      } catch (error) {
        console.log(`The deploy did not finish: ${error instanceof Error ? error.message : String(error)}`);
      }
      const deployed = previousBot(id)?.deployment !== undefined;
      if (code === 0 && deployed) return 0;
      console.log("");
      console.log(`The bot is funded and ${deployed ? "its droplet exists, but the runner was not confirmed running" : "not deployed"}. To ${deployed ? "finish" : "deploy"}: strats deploy, or strats init again.`);
      if (!deployed) sayLocalRun(session.bot);
      return code === 0 ? 0 : 1;
    }
  }

  const { deployment } = session.bot;
  if (deployment) {
    // Reached with --force on a bot that is already deployed: the droplet still holds what it was given.
    console.log(`Bot "${id}" is deployed on ${deployment.host} (${deployment.region}). The droplet keeps the settings it was deployed with. To send it the current ones: strats deploy`);
    for (const line of watchLines(session.bot)) console.log(line);
    return 0;
  }
  console.log(`Bot "${id}" is set up and funded. It is not deployed${noDeploy ? ", as you asked" : ""}.`);
  sayLocalRun(session.bot);
  return 0;
}
