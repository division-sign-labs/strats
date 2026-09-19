// The local bot file. It holds addresses and settings only. The API key and
// every private key live in the encrypted keystore, never here.
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { SplitSchema, TokenSchema, type Split, type Token } from "./protocol/index.js";
import { botFile, listBotIds, writePrivateFile } from "./paths.js";

/** Keystore entry name for the Quotient API key. */
export const API_KEY_ROLE = "strats-api-key";
export const MAX_POSITION_PCT = 50;

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

/** Where the bot runs unattended. Addresses and ids only. */
export const DeploymentSchema = z.object({
  dropletId: z.number().int().positive(),
  host: z.string().min(1),
  region: z.string().min(1),
  size: z.string().min(1),
  version: z.string().min(1),
  deployedAt: z.string(),
  /** True from the moment the droplet exists until its runner is confirmed active. A deploy that was stopped in between is finished by running it again. */
  pending: z.boolean().optional(),
});
export type Deployment = z.infer<typeof DeploymentSchema>;

export const BotStateSchema = z.object({
  v: z.literal(1),
  id: z.string(),
  /** Bots created before 0.2.0 have no field and are single-asset bots. */
  strategyId: z.enum(["stock-ls", "theme", "team"]).default("stock-ls"),
  gatewayUrl: z.string().min(1),
  /** First 12 characters of the API key, for recognition only. */
  keyPrefix: z.string().max(12),
  masterAddress: address,
  agentAddress: address.optional(),
  /**
   * The Polymarket account. funder is the deposit wallet that holds the funds. A theme or team bot signs with masterAddress.
   * A single-asset bot that also trades markets signs with a key of its own, so its Hyperliquid master key never leaves this machine.
   */
  polymarket: z.object({ signerAddress: address, funder: address, signatureType: z.number().int() }).optional(),
  /**
   * Present only on a single-asset bot whose settings list Polymarket markets: one key, one bot, two venues.
   * It records the Polymarket funding step, which may be skipped to start with the perp only. Bots created before 0.5.0 have no field.
   */
  markets: z.object({ fundedAt: z.string().optional(), skippedAt: z.string().optional() }).optional(),
  deployment: DeploymentSchema.optional(),
  /** When strats fund last finished. Bots funded before 0.3.0 have no field. */
  fundedAt: z.string().optional(),
  /**
   * True only when the creator chose to show this bot's wallet on its public project page.
   * Then, and only then, a report carries the wallet address. Not a secret. Bots created before 0.3.0 have no field, which means false.
   */
  publishWallet: z.boolean().optional(),
  ceilingPct: z.number().positive().max(MAX_POSITION_PCT),
  /**
   * Where a payout goes. `destination` is set only by strats buyback --to; without it the bought token goes to this bot's own wallet.
   * Like the token and the split, it is read from this file and never from the server.
   */
  pinned: z.object({ token: TokenSchema, split: SplitSchema, destination: address.optional() }),
  createdAt: z.string(),
});
export type BotState = z.infer<typeof BotStateSchema>;
export type Pinned = BotState["pinned"];

/** Theme and team bots trade on Polymarket from a deposit wallet; a single-asset bot trades on Hyperliquid. */
export const isPolymarketBot = (bot: Pick<BotState, "strategyId">): boolean => bot.strategyId !== "stock-ls";

/** A single-asset bot that also trades its asset's Polymarket markets: the perp on Hyperliquid and the markets on Polymarket, under one key. */
export const isTwoVenueBot = (bot: Pick<BotState, "strategyId" | "markets">): boolean => bot.strategyId === "stock-ls" && bot.markets !== undefined;

/** A two-venue bot keeps its Polymarket counters in a file of their own, because both loops run in one process. */
export const marketsStateScope = (bot: Pick<BotState, "strategyId" | "markets">): "markets" | undefined => (isTwoVenueBot(bot) ? "markets" : undefined);

export function botExists(id: string): boolean {
  return existsSync(botFile(id));
}

export function loadBot(id: string): BotState {
  const path = botFile(id);
  if (!existsSync(path)) throw new Error(`No bot named "${id}". Run: strats init --key qsk_...`);
  const parsed = BotStateSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`The bot file ${path} is not valid.`);
  if (parsed.data.id !== id) throw new Error(`The bot file ${path} belongs to a different bot id.`);
  return parsed.data;
}

export function saveBot(state: BotState): void {
  writePrivateFile(botFile(state.id), `${JSON.stringify(BotStateSchema.parse(state), null, 2)}\n`);
}

/** Use --id when given; otherwise the only bot on this machine. */
export function resolveBotId(requested: string | undefined): string {
  if (requested) return requested;
  const ids = listBotIds();
  if (ids.length === 1) return ids[0]!;
  if (ids.length === 0) throw new Error("No bot is set up yet. Run: strats init --key qsk_...");
  throw new Error(`More than one bot is set up (${ids.join(", ")}). Choose one with --id.`);
}

/**
 * Compare the server's payout settings with the pinned ones. The pinned values
 * win until the operator runs `strats config accept`, so a change made on the
 * server alone can never redirect a payout.
 */
export function pinnedDifferences(pinned: Pinned, server: { token: Token; split: Split }): string[] {
  const differences: string[] = [];
  if (pinned.token.chainId !== server.token.chainId) {
    differences.push(`token chain: pinned ${pinned.token.chainId}, server ${server.token.chainId}`);
  }
  // Hex addresses differ only by checksum casing; anything else is compared exactly.
  const hex = address.safeParse(pinned.token.address).success && address.safeParse(server.token.address).success;
  const sameAddress = hex ? pinned.token.address.toLowerCase() === server.token.address.toLowerCase() : pinned.token.address === server.token.address;
  if (!sameAddress) {
    differences.push(`token address: pinned ${pinned.token.address}, server ${server.token.address}`);
  }
  if (pinned.split.buybackPct !== server.split.buybackPct) {
    differences.push(`buyback share: pinned ${pinned.split.buybackPct}%, server ${server.split.buybackPct}%`);
  }
  if (pinned.split.keepPct !== server.split.keepPct) {
    differences.push(`kept share: pinned ${pinned.split.keepPct}%, server ${server.split.keepPct}%`);
  }
  return differences;
}
