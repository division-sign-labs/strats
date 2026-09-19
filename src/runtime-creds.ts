// The one value a deployed runner receives instead of a keystore. `strats
// deploy` builds it on this machine and sends it over ssh stdin; `strats run`
// reads it from STRATS_RUNTIME_CREDS when present. It never contains the
// keystore, the passphrase, or a Hyperliquid master key.
import { z } from "zod";
import { BotStateSchema, isPolymarketBot, type BotState } from "./state.js";

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
});
export type RuntimeCredsDoc = z.infer<typeof RuntimeCredsSchema>;

export interface RuntimeCredsInput {
  apiKey: string;
  gatewayUrl: string;
  bot: BotState;
  hyperliquid?: { agentPk: string; masterAddress: string };
  polymarket?: PolymarketCreds;
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
  return RuntimeCredsSchema.parse({
    apiKey: input.apiKey,
    gatewayUrl: input.gatewayUrl,
    botState,
    ...(isPolymarketBot(input.bot)
      ? { polymarket: input.polymarket }
      : { hyperliquid: { agentPk: input.hyperliquid!.agentPk, masterAddress: input.hyperliquid!.masterAddress } }),
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
