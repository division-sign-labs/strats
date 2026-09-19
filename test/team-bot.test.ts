// A team bot is a Polymarket bot: everything a theme bot does around the loop
// (account, funding, credentials, droplet, reports) applies to it unchanged.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addressFromPk } from "@quotient-forecasting/cassie-core";
import { disclosure } from "../src/commands/deploy.js";
import { describeConfig } from "../src/commands/init.js";
import { describePublication } from "../src/commands/config.js";
import { isFunded, nextInitStage, type InitBot } from "../src/install.js";
import { parseTeamConfig } from "../src/protocol/index.js";
import { publishedWalletAddress } from "../src/report.js";
import { buildRuntimeCreds, decodeRuntimeCreds, encodeRuntimeCreds } from "../src/runtime-creds.js";
import { BotStateSchema, isPolymarketBot, type BotState } from "../src/state.js";

// Built at run time so no key-shaped literal sits in the repository.
const hexKey = (byte: string): string => `0x${byte.repeat(32)}`;
const SIGNER_PK = hexKey("a1");
const AGENT_PK = hexKey("b2");
const API_KEY = `qsk_${"test".repeat(3)}`;
const FUNDER = `0x${"f1".repeat(20)}`;
const L2 = { apiKey: "l2-key-id", secret: "l2-secret-value", passphrase: "l2-pass-value" };
const account = { signerAddress: addressFromPk(SIGNER_PK), funder: FUNDER, signatureType: 3 };

const teamBot = (over: Partial<BotState> = {}): BotState => ({
  v: 1, id: "mets", strategyId: "team", gatewayUrl: "https://quotient-api-gateway.onrender.com", keyPrefix: API_KEY.slice(0, 12),
  masterAddress: addressFromPk(SIGNER_PK), polymarket: account, ceilingPct: 5, createdAt: "2026-09-18T00:00:00.000Z",
  pinned: { token: { chainId: 8453, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, split: { buybackPct: 70, keepPct: 30 } },
  ...over,
});

describe("a team bot", () => {
  it("is a valid bot file, and a Polymarket bot", () => {
    assert.equal(BotStateSchema.safeParse(teamBot()).success, true);
    assert.equal(isPolymarketBot({ strategyId: "team" }), true);
    assert.equal(isPolymarketBot({ strategyId: "theme" }), true);
    assert.equal(isPolymarketBot({ strategyId: "stock-ls" }), false);
    assert.equal(BotStateSchema.safeParse({ ...teamBot(), strategyId: "sports" }).success, false);
  });

  it("walks the same init stages as a theme bot: the Polymarket account comes before funding", () => {
    const team = (over: Partial<InitBot> = {}): InitBot => ({ strategyId: "team", ...over });
    assert.equal(nextInitStage({ bot: team() }), "account");
    assert.equal(nextInitStage({ bot: team({ polymarket: account }), polymarketCredsStored: false }), "account");
    assert.equal(nextInitStage({ bot: team({ polymarket: account }) }), "fund");
    assert.equal(nextInitStage({ bot: team({ polymarket: account, fundedAt: "2026-09-19T00:00:00.000Z" }) }), "deploy");
    assert.equal(nextInitStage({ bot: team({ polymarket: account, fundedAt: "2026-09-19T00:00:00.000Z" }), noDeploy: true }), "done");
    // There is no trading-only key on Polymarket, so an agent address proves nothing about funding.
    assert.equal(isFunded(team({ polymarket: account, agentAddress: FUNDER })), false);
  });

  it("sends the droplet exactly the Polymarket credentials, and no Hyperliquid arm", () => {
    const polymarket = { venue: "polymarket" as const, signerPk: SIGNER_PK, funder: FUNDER, signatureType: 3, l2: L2 };
    const doc = buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: teamBot().gatewayUrl, bot: teamBot(), polymarket, hyperliquid: { agentPk: AGENT_PK, masterAddress: FUNDER } });
    assert.deepEqual(Object.keys(doc).sort(), ["apiKey", "botState", "gatewayUrl", "polymarket"]);
    assert.deepEqual(Object.keys(doc.polymarket!).sort(), ["funder", "l2", "signatureType", "signerPk", "venue"]);
    const decoded = decodeRuntimeCreds(encodeRuntimeCreds(doc));
    assert.equal(decoded.botState.strategyId, "team");
    assert.ok(!Buffer.from(encodeRuntimeCreds(doc), "base64url").toString("utf8").includes(AGENT_PK));
    assert.throws(() => buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: "https://x.example", bot: teamBot() }), /strats fund/);
  });

  it("is told before a deploy that the droplet holds the wallet key", () => {
    const lines = disclosure(teamBot()).join(" ");
    assert.match(lines, /the Polymarket wallet key and its API credentials/);
    assert.match(lines, /Whoever controls the droplet controls the funds/);
  });

  it("publishes the deposit wallet, never the signing address, and only when asked to", () => {
    assert.equal(publishedWalletAddress(teamBot()), undefined);
    assert.equal(publishedWalletAddress(teamBot({ publishWallet: true })), FUNDER);
    assert.match(describePublication(teamBot({ publishWallet: true })), new RegExp(FUNDER));
  });
});

describe("describeConfig for a team", () => {
  const account = { positionPct: 10, token: { chainId: 8453, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, split: { buybackPct: 70, keepPct: 30 } };
  const config = (mode: string, marginPts = 10) => {
    const parsed = parseTeamConfig({
      strategyId: "team", version: 1, updatedAt: "2026-09-19T00:00:00.000Z",
      config: { v: 1, strategyId: "team", strategy: { team: { id: "114207", name: "New York Mets", alias: "Mets", abbreviation: "nym", league: "mlb", sport: "baseball" }, mode, marginPts, maxPriceCents: 85 }, account },
    });
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.value;
  };

  it("shows the team, the bet in the site's words, and the price limit", () => {
    assert.deepEqual(describeConfig(config("against")).slice(0, 4), [
      "  Strategy         Back a team, on Polymarket",
      "  Team             New York Mets (MLB)",
      "  Bet              Always bet against them",
      "  Pay at most      85¢",
    ]);
  });

  it("shows the lead needed only for the bets that read it", () => {
    assert.ok(describeConfig(config("back-favored")).includes("  Lead needed      10 points"));
    assert.ok(describeConfig(config("follow", 1)).includes("  Lead needed      1 point"));
    assert.ok(!describeConfig(config("back")).some((line) => line.includes("Lead needed")));
  });
});
