// What every command after init needs: the bot file, the unlocked keystore,
// and the API key for the gateway. The master key is never read here.
import { KeyRoles, addressFromPk, type Keystore } from "@quotient-forecasting/cassie-core";
import type { Args } from "./args.js";
import { normalizeGatewayUrl, type GatewayOptions } from "./client.js";
import { ensureHome } from "./paths.js";
import { checkPassphrase, openKeystore, readPassphrase, readSecret, type Prompts } from "./setup.js";
import { API_KEY_ROLE, loadBot, resolveBotId, type BotState } from "./state.js";

export interface Session {
  bot: BotState;
  keystore: Keystore;
  passphrase: string;
  gateway: GatewayOptions;
}

export async function openSession(args: Args, prompts: Prompts): Promise<Session> {
  ensureHome();
  const bot = loadBot(resolveBotId(args.values.id));
  const keystore = openKeystore();
  const passphrase = await readPassphrase(prompts);
  checkPassphrase(keystore, bot.id, passphrase);
  const apiKey = readSecret(keystore, bot.id, API_KEY_ROLE, passphrase);
  if (!apiKey) throw new Error("The keystore has no API key. Run strats init again with --force.");
  const gatewayUrl = normalizeGatewayUrl(args.values.gateway ?? process.env.STRATS_GATEWAY_URL ?? bot.gatewayUrl);
  return { bot, keystore, passphrase, gateway: { gatewayUrl, apiKey } };
}

/** The agent key signs orders. It is checked against the address approved during funding before it is used. */
export function loadAgentKey(session: Session): string {
  const { bot, keystore, passphrase } = session;
  const agentPk = readSecret(keystore, bot.id, KeyRoles.agent, passphrase);
  if (!agentPk || !bot.agentAddress) throw new Error("This bot has no approved trading key yet. Run: strats fund");
  if (addressFromPk(agentPk).toLowerCase() !== bot.agentAddress.toLowerCase()) {
    throw new Error("The trading key in the keystore does not match the address approved on Hyperliquid. Run strats fund again.");
  }
  return agentPk;
}

/** Remove any secret that an upstream error message might carry before a line is printed or logged. */
export function scrub(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out;
}
