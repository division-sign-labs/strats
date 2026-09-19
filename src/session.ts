// What every command after init needs: the bot file, the API key for the
// gateway, and a way to reach the trading credentials. On the operator's
// machine that is the encrypted keystore. On a deployed droplet it is the
// STRATS_RUNTIME_CREDS value, and there is no keystore at all. The Hyperliquid
// master key is read here by loadWalletKey only, for a buyback.
import { KeyRoles, addressFromPk, type Keystore } from "@quotient-forecasting/cassie-core";
import type { Args } from "./args.js";
import { normalizeGatewayUrl, type GatewayOptions } from "./client.js";
import { ensureHome } from "./paths.js";
import { RUNTIME_CREDS_ENV, decodeRuntimeCreds, type PolymarketCreds, type RuntimeCredsDoc } from "./runtime-creds.js";
import { checkPassphrase, openKeystore, readPassphrase, readSecret, type Prompts } from "./setup.js";
import { API_KEY_ROLE, isPolymarketBot, isTwoVenueBot, loadBot, resolveBotId, type BotState } from "./state.js";

export const POLYMARKET_L2_ROLE = "polymarket-l2";
/** A two-venue bot's Polymarket signer. It is a key of its own, so deploying the bot never sends the Hyperliquid master key anywhere. */
export const POLYMARKET_SIGNER_ROLE = "polymarket-signer";
/** The keystore entry that signs this bot's Polymarket orders. */
export const polymarketSignerRole = (bot: Pick<BotState, "strategyId" | "markets">): string => (isTwoVenueBot(bot) ? POLYMARKET_SIGNER_ROLE : KeyRoles.master);

export interface Session {
  bot: BotState;
  gateway: GatewayOptions;
  /** Present on the operator's machine. */
  keystore?: Keystore;
  passphrase?: string;
  /** Present on a deployed droplet. */
  runtime?: RuntimeCredsDoc;
}

export type KeystoreSession = Session & { keystore: Keystore; passphrase: string };

export function runtimeCredsPresent(): boolean {
  return (process.env[RUNTIME_CREDS_ENV] ?? "").trim() !== "";
}

export async function openSession(args: Args, prompts: Prompts): Promise<Session> {
  ensureHome();
  if (runtimeCredsPresent()) {
    const runtime = decodeRuntimeCreds(process.env[RUNTIME_CREDS_ENV]!);
    // The value stays in this process only; child processes never inherit it.
    delete process.env[RUNTIME_CREDS_ENV];
    if (args.values.id && args.values.id !== runtime.botState.id) throw new Error(`These runtime credentials belong to bot "${runtime.botState.id}", not "${args.values.id}".`);
    return { bot: runtime.botState, runtime, gateway: { gatewayUrl: normalizeGatewayUrl(runtime.gatewayUrl), apiKey: runtime.apiKey } };
  }
  const bot = loadBot(resolveBotId(args.values.id));
  const keystore = openKeystore();
  const passphrase = await readPassphrase(prompts);
  checkPassphrase(keystore, bot.id, passphrase);
  const apiKey = readSecret(keystore, bot.id, API_KEY_ROLE, passphrase);
  if (!apiKey) throw new Error("The keystore has no API key. Run strats init again with --force.");
  const gatewayUrl = normalizeGatewayUrl(args.values.gateway ?? process.env.STRATS_GATEWAY_URL ?? bot.gatewayUrl);
  return { bot, keystore, passphrase, gateway: { gatewayUrl, apiKey } };
}

/** fund, config, deploy and init change local files or read the wallet key, so they need the keystore. */
export function requireKeystore(session: Session, command: string): KeystoreSession {
  if (!session.keystore || session.passphrase === undefined) throw new Error(`strats ${command} needs the local keystore. Run it on the machine where you ran strats init.`);
  return session as KeystoreSession;
}

/** The agent key signs orders. It is checked against the address approved during funding before it is used. */
export function loadAgentKey(session: Session): string {
  const { bot } = session;
  const agentPk = session.runtime ? session.runtime.hyperliquid?.agentPk ?? null : readSecret(session.keystore!, bot.id, KeyRoles.agent, session.passphrase!);
  if (!agentPk || !bot.agentAddress) throw new Error("This bot has no approved trading key yet. Run: strats fund");
  if (addressFromPk(agentPk).toLowerCase() !== bot.agentAddress.toLowerCase()) {
    throw new Error("The trading key in the keystore does not match the address approved on Hyperliquid. Run strats fund again.");
  }
  return agentPk;
}

/**
 * Polymarket has no separate trading key: its SDK signs every order with the
 * wallet's own key, so that key is part of the trading credentials.
 */
export function loadPolymarketCreds(session: Session): PolymarketCreds {
  const { bot } = session;
  if (!bot.polymarket) throw new Error("This bot has no Polymarket account yet. Run: strats init");
  if (session.runtime) {
    if (!session.runtime.polymarket) throw new Error("The runtime credentials carry no Polymarket account. Run strats deploy again.");
    return session.runtime.polymarket;
  }
  const signerPk = readSecret(session.keystore!, bot.id, polymarketSignerRole(bot), session.passphrase!);
  const l2Raw = readSecret(session.keystore!, bot.id, POLYMARKET_L2_ROLE, session.passphrase!);
  if (!signerPk || !l2Raw) throw new Error("The keystore has no Polymarket credentials. Run: strats init --force");
  if (addressFromPk(signerPk).toLowerCase() !== bot.polymarket.signerAddress.toLowerCase()) {
    throw new Error("The wallet key in the keystore does not match this bot's Polymarket signer.");
  }
  let l2: { apiKey?: unknown; secret?: unknown; passphrase?: unknown };
  try {
    l2 = JSON.parse(l2Raw) as typeof l2;
  } catch {
    throw new Error("The Polymarket API credentials in the keystore are damaged. Run: strats init --force");
  }
  if (typeof l2.apiKey !== "string" || typeof l2.secret !== "string" || typeof l2.passphrase !== "string") {
    throw new Error("The Polymarket API credentials in the keystore are incomplete. Run: strats init --force");
  }
  return { venue: "polymarket", signerPk, funder: bot.polymarket.funder, signatureType: bot.polymarket.signatureType, l2: { apiKey: l2.apiKey, secret: l2.secret, passphrase: l2.passphrase } };
}

/**
 * The key of the bot's own wallet, which a buyback withdraws and swaps with. On the creator's machine it comes from the keystore.
 * On a droplet it is there only when the creator turned auto-buyback on: a Hyperliquid bot's master key travels in its own arm of the
 * runtime credentials, and a theme or team bot's wallet key is the Polymarket signer the droplet already holds. Null when there is none.
 */
export function loadWalletKey(session: Session): string | null {
  const { bot } = session;
  // A droplet's credentials are usable for a buyback only when the creator opted in.
  if (session.runtime && bot.autoBuyback !== true) return null;
  const key = session.runtime
    ? session.runtime.buyback?.masterPk ?? (isPolymarketBot(bot) ? session.runtime.polymarket?.signerPk ?? null : null)
    : readSecret(session.keystore!, bot.id, KeyRoles.master, session.passphrase!);
  if (key && addressFromPk(key).toLowerCase() !== bot.masterAddress.toLowerCase()) throw new Error("The wallet key does not match this bot's wallet address.");
  return key;
}

/** Every secret a session can reach, for scrubbing a line before it is printed or logged. */
export function sessionSecrets(session: Session): Array<string | undefined> {
  const r = session.runtime;
  return [session.gateway.apiKey, session.passphrase, r?.hyperliquid?.agentPk, r?.buyback?.masterPk, r?.polymarket?.signerPk, r?.polymarket?.l2.secret, r?.polymarket?.l2.passphrase, r?.polymarket?.l2.apiKey];
}

/** Remove any secret that an upstream error message might carry before a line is printed or logged. */
export function scrub(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out;
}
