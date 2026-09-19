// strats init: read the settings through the gateway, create the wallet and
// the keystore, pin the payout settings, and say how to fund the wallet.
import { KeyRoles, generateEoa } from "@quotient-forecasting/cassie-core";
import { UsageError, type Args } from "../args.js";
import { DEFAULT_GATEWAY_URL, fetchConfig, normalizeGatewayUrl } from "../client.js";
import { DEFAULT_BOT_ID, assertBotId, ensureHome, keysDir } from "../paths.js";
import type { ConfigDoc } from "../protocol/index.js";
import { VENUE_MIN_NOTIONAL_USD, effectivePct } from "../reconcile.js";
import { checkPassphrase, openKeystore, readPassphrase, type Prompts } from "../setup.js";
import { API_KEY_ROLE, MAX_POSITION_PCT, botExists, loadBot, saveBot } from "../state.js";
import { buildAdapter } from "../venue.js";

const CHAIN_NAMES: Record<number, string> = { 1: "Ethereum", 10: "Optimism", 137: "Polygon", 8453: "Base", 42161: "Arbitrum" };
export const chainName = (chainId: number): string => (CHAIN_NAMES[chainId] ? `${CHAIN_NAMES[chainId]} (chain ${chainId})` : `chain ${chainId}`);

export function describeConfig(doc: ConfigDoc): string[] {
  const { strategy, account } = doc.config;
  return [
    `  Asset            ${strategy.assetKey}`,
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

function previousCreatedAt(id: string): string | undefined {
  try {
    return botExists(id) ? loadBot(id).createdAt : undefined;
  } catch {
    return undefined;
  }
}

export async function init(args: Args, prompts: Prompts): Promise<number> {
  const id = assertBotId(args.values.id ?? DEFAULT_BOT_ID);
  const gatewayUrl = normalizeGatewayUrl(args.values.gateway ?? process.env.STRATS_GATEWAY_URL ?? DEFAULT_GATEWAY_URL);
  ensureHome();
  const keystore = openKeystore();
  const existing = botExists(id) || keystore.exists(id);
  if (existing && !args.flags.has("force")) {
    console.log(`A bot named "${id}" already exists. Use --force to replace its settings (the wallet is kept), or --id to create another bot.`);
    return 1;
  }

  // --key is convenient; STRATS_API_KEY or the prompt keep the key out of shell history.
  const apiKey = (args.values.key ?? process.env.STRATS_API_KEY ?? (await prompts.ask("API key (qsk_...)", { secret: true }))).trim();
  if (!/^qsk_[A-Za-z0-9_-]{8,}$/.test(apiKey)) throw new UsageError("The API key should start with qsk_. Copy it from TokenStrats.");

  const config = await fetchConfig({ gatewayUrl, apiKey });
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

  saveBot({
    v: 1,
    id,
    gatewayUrl,
    keyPrefix: apiKey.slice(0, 12),
    masterAddress,
    ...(keptWallet && agentAddress ? { agentAddress } : {}),
    ceilingPct,
    pinned: { token: account.token, split: account.split },
    // Profit is measured from the wallet's first day, so a re-init keeps the original date.
    createdAt: (keptWallet && previousCreatedAt(id)) || new Date().toISOString(),
  });

  const pct = effectivePct(account.positionPct, ceilingPct);
  const funding = (await buildAdapter("").fundingInstructions({ venue: "hyperliquid", masterAddress })).addresses[0];
  console.log(keptWallet ? "Kept the existing wallet." : "Wallet created.");
  console.log(`  Address          ${masterAddress}`);
  console.log(`  Keystore         ${keysDir()} (encrypted; the keys never leave this machine)`);
  console.log(`  Ceiling          ${ceilingPct}% of the wallet per position`);
  console.log(`  Payout settings  pinned from this config; a later change on the server needs "strats config accept"`);
  console.log("");
  console.log("Fund the wallet");
  console.log(`  Send USDC on Arbitrum to ${masterAddress}.`);
  console.log(`  Hyperliquid's minimum deposit is ${funding?.minimum ?? 5} USDC. A smaller deposit is lost.`);
  console.log(`  The smallest order Hyperliquid accepts is $${VENUE_MIN_NOTIONAL_USD}. At ${pct}% per position the wallet needs at least $${Math.ceil((VENUE_MIN_NOTIONAL_USD * 100) / pct)} to trade. Deposit somewhat more to leave room for rounding and fees.`);
  console.log("  The wallet also needs a little ETH on Arbitrum to pay for the deposit transaction.");
  console.log("");
  console.log("Next: strats fund");
  return 0;
}
