// The one value a deployed runner receives instead of a keystore. `strats
// deploy` builds it on this machine and sends it over ssh stdin; `strats run`
// reads it from STRATS_RUNTIME_CREDS when present. It never contains the
// keystore or the passphrase. It contains a Hyperliquid master key in one case
// only: the creator turned auto-buyback on, which is the choice to let the
// droplet withdraw. With auto-buyback off it is exactly what it was before 0.5.0.
import { addressFromPk } from "@quotient-forecasting/cassie-core";
import { z } from "zod";
import { BotStateSchema, isPolymarketBot, isTwoVenueBot, sendsMasterKey, type BotState } from "./state.js";

export const RUNTIME_CREDS_ENV = "STRATS_RUNTIME_CREDS";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/** Exactly the Polymarket arm of cassie-core's RuntimeCreds. */
const PolymarketCredsSchema = z.strictObject({
  venue: z.literal("polymarket"),
  signerPk: privateKey,
  funder: address,
  signatureType: z.number().int(),
  l2: z.strictObject({ apiKey: z.string().min(1), secret: z.string().min(1), passphrase: z.string().min(1) }),
});
export type PolymarketCreds = z.infer<typeof PolymarketCredsSchema>;

export const RuntimeCredsSchema = z.strictObject({
  apiKey: z.string().regex(/^qsk_/),
  gatewayUrl: z.string().min(1),
  /** The bot file: addresses and settings, no secrets. */
  botState: BotStateSchema,
  hyperliquid: z.strictObject({ agentPk: privateKey, masterAddress: address }).optional(),
  polymarket: PolymarketCredsSchema.optional(),
  /**
   * Present only when the bot file says autoBuyback, and only for a bot whose money is on Hyperliquid: the wallet's master key,
   * which a buyback withdraws and swaps with. A theme or team bot's wallet key is already in its Polymarket arm, so it gets no arm here.
   */
  buyback: z.strictObject({ masterPk: privateKey }).optional(),
});
export type RuntimeCredsDoc = z.infer<typeof RuntimeCredsSchema>;

export interface RuntimeCredsInput {
  apiKey: string;
  gatewayUrl: string;
  bot: BotState;
  hyperliquid?: { agentPk: string; masterAddress: string };
  polymarket?: PolymarketCreds;
  /** The wallet's master key. Used only when the bot file says autoBuyback; otherwise it is dropped here, whatever the caller passed. */
  buybackMasterPk?: string;
}

/**
 * Build the document from named fields only. The schema is strict, so nothing
 * that is not listed here can ride along, and the deployment record is dropped
 * because the droplet has no use for it.
 */
export function buildRuntimeCreds(input: RuntimeCredsInput): RuntimeCredsDoc {
  const { deployment: _deployment, ...botState } = input.bot;
  if (isPolymarketBot(input.bot) ? !input.polymarket : !input.hyperliquid) {
    throw new Error("The trading credentials for this bot's venue are missing. Run strats fund first.");
  }
  // A two-venue bot carries both arms. Its Polymarket arm is optional here: without it the droplet runs the perp only.
  const polymarket = isPolymarketBot(input.bot) || isTwoVenueBot(input.bot) ? input.polymarket : undefined;
  const withMaster = sendsMasterKey(input.bot);
  if (withMaster) {
    if (!input.buybackMasterPk) throw new Error("Auto-buyback is on, and the wallet key it needs was not read from the keystore.");
    if (addressFromPk(input.buybackMasterPk).toLowerCase() !== input.bot.masterAddress.toLowerCase()) throw new Error("The wallet key in the keystore does not match this bot's wallet address.");
  }
  return RuntimeCredsSchema.parse({
    apiKey: input.apiKey,
    gatewayUrl: input.gatewayUrl,
    botState,
    ...(isPolymarketBot(input.bot) ? {} : { hyperliquid: { agentPk: input.hyperliquid!.agentPk, masterAddress: input.hyperliquid!.masterAddress } }),
    ...(polymarket ? { polymarket } : {}),
    ...(withMaster ? { buyback: { masterPk: input.buybackMasterPk! } } : {}),
  });
}

/** base64url keeps the value free of quotes and spaces, so a systemd EnvironmentFile carries it unchanged. */
export function encodeRuntimeCreds(doc: RuntimeCredsDoc): string {
  return Buffer.from(JSON.stringify(RuntimeCredsSchema.parse(doc)), "utf8").toString("base64url");
}

/** Errors never echo the value. */
export function decodeRuntimeCreds(raw: string): RuntimeCredsDoc {
  let parsed: unknown;
  try {
    const text = raw.trim();
    parsed = JSON.parse(text.startsWith("{") ? text : Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    throw new Error(`${RUNTIME_CREDS_ENV} is not readable. Run strats deploy again.`);
  }
  const result = RuntimeCredsSchema.safeParse(parsed);
  if (!result.success) throw new Error(`${RUNTIME_CREDS_ENV} does not match this version of the runner. Run strats deploy again.`);
  return result.data;
}
