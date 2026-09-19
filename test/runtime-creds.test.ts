import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { KeyRoles, Keystore, addressFromPk } from "@quotient-forecasting/cassie-core";
import { parseArgs } from "../src/args.js";
import { ensureHome, keysDir } from "../src/paths.js";
import { RUNTIME_CREDS_ENV, buildRuntimeCreds, decodeRuntimeCreds, encodeRuntimeCreds } from "../src/runtime-creds.js";
import { loadAgentKey, loadPolymarketCreds, openSession, requireKeystore } from "../src/session.js";
import { Prompts } from "../src/setup.js";
import { API_KEY_ROLE, saveBot, type BotState } from "../src/state.js";

// Built at run time so no key-shaped literal sits in the repository.
const hexKey = (byte: string): string => `0x${byte.repeat(32)}`;
const MASTER_PK = hexKey("a1");
const AGENT_PK = hexKey("b2");
const PASSPHRASE = ["correct", "horse", "battery"].join("-");
const API_KEY = `qsk_${"test".repeat(3)}`;
const L2 = { apiKey: "l2-key-id", secret: "l2-secret-value", passphrase: "l2-pass-value" };

const baseBot = (over: Partial<BotState> = {}): BotState => ({
  v: 1, id: "alpha", strategyId: "stock-ls", gatewayUrl: "https://quotient-api-gateway.onrender.com", keyPrefix: API_KEY.slice(0, 12),
  masterAddress: addressFromPk(MASTER_PK), agentAddress: addressFromPk(AGENT_PK), ceilingPct: 5, createdAt: "2026-09-18T00:00:00.000Z",
  pinned: { token: { chainId: 8453, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, split: { buybackPct: 70, keepPct: 30 } },
  ...over,
});

describe("runtime credentials", () => {
  it("carry the trading key for a Hyperliquid bot and never the master key or the passphrase", () => {
    const bot = baseBot({ deployment: { dropletId: 1, host: "203.0.113.5", region: "blr1", size: "s-1vcpu-1gb", version: "0.2.0", deployedAt: "2026-09-19T00:00:00.000Z" } });
    const doc = buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: bot.gatewayUrl, bot, hyperliquid: { agentPk: AGENT_PK, masterAddress: bot.masterAddress } });
    const wire = Buffer.from(encodeRuntimeCreds(doc), "base64url").toString("utf8");
    assert.ok(wire.includes(AGENT_PK));
    assert.ok(!wire.includes(MASTER_PK), "master key");
    assert.ok(!wire.includes(PASSPHRASE), "passphrase");
    assert.ok(!wire.includes("203.0.113.5"), "deployment record");
    assert.deepEqual(Object.keys(doc).sort(), ["apiKey", "botState", "gatewayUrl", "hyperliquid"]);
    assert.deepEqual(Object.keys(doc.hyperliquid!).sort(), ["agentPk", "masterAddress"]);
  });

  it("ignore extra fields handed to the builder, including a master key or passphrase", () => {
    const bot = baseBot();
    const sneaky = { apiKey: API_KEY, gatewayUrl: bot.gatewayUrl, bot, hyperliquid: { agentPk: AGENT_PK, masterAddress: bot.masterAddress, masterPk: MASTER_PK }, passphrase: PASSPHRASE, masterPk: MASTER_PK, keystore: { entries: {} } };
    const wire = JSON.stringify(buildRuntimeCreds(sneaky as never));
    assert.ok(!wire.includes(MASTER_PK));
    assert.ok(!wire.includes(PASSPHRASE));
    assert.ok(!wire.includes("keystore"));
  });

  it("carry exactly the cassie-core Polymarket arm for a theme bot, and no Hyperliquid arm", () => {
    const signer = addressFromPk(MASTER_PK);
    const bot = baseBot({ strategyId: "theme", agentAddress: undefined, polymarket: { signerAddress: signer, funder: "0x00000000000000000000000000000000000000f1", signatureType: 3 } });
    const polymarket = { venue: "polymarket" as const, signerPk: MASTER_PK, funder: bot.polymarket!.funder, signatureType: 3, l2: L2 };
    const doc = buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: bot.gatewayUrl, bot, polymarket, hyperliquid: { agentPk: AGENT_PK, masterAddress: signer } });
    assert.deepEqual(Object.keys(doc.polymarket!).sort(), ["funder", "l2", "signatureType", "signerPk", "venue"]);
    assert.equal(doc.hyperliquid, undefined);
    assert.ok(!JSON.stringify(doc).includes(PASSPHRASE));
  });

  it("carry the choice to publish the wallet, so the droplet knows, and still nothing secret beyond the trading key", () => {
    const bot = baseBot({ publishWallet: true, fundedAt: "2026-09-19T00:00:00.000Z" });
    const doc = buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: bot.gatewayUrl, bot, hyperliquid: { agentPk: AGENT_PK, masterAddress: bot.masterAddress } });
    const decoded = decodeRuntimeCreds(encodeRuntimeCreds(doc));
    assert.equal(decoded.botState.publishWallet, true);
    assert.equal(decodeRuntimeCreds(encodeRuntimeCreds(buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: bot.gatewayUrl, bot: baseBot(), hyperliquid: { agentPk: AGENT_PK, masterAddress: bot.masterAddress } }))).botState.publishWallet, undefined);

    const wire = Buffer.from(encodeRuntimeCreds(doc), "base64url").toString("utf8");
    assert.ok(!wire.includes(MASTER_PK), "master key");
    assert.ok(!wire.includes(PASSPHRASE), "passphrase");
    assert.ok(!/keystore|ciphertext|scrypt/i.test(wire), "keystore");
    assert.deepEqual(Object.keys(doc).sort(), ["apiKey", "botState", "gatewayUrl", "hyperliquid"]);
    // The only 32-byte secret on the wire is the trading key.
    assert.deepEqual([...wire.matchAll(/0x[0-9a-fA-F]{64}/g)].map((m) => m[0]), [AGENT_PK]);
  });

  it("refuse to build without the venue's trading credentials", () => {
    assert.throws(() => buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: "https://x.example", bot: baseBot() }), /strats fund/);
    assert.throws(() => buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: "https://x.example", bot: baseBot({ strategyId: "theme" }) }), /strats fund/);
  });

  it("round-trip through the env encoding, reject unknown fields, and never echo the value in an error", () => {
    const bot = baseBot();
    const doc = buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: bot.gatewayUrl, bot, hyperliquid: { agentPk: AGENT_PK, masterAddress: bot.masterAddress } });
    const encoded = encodeRuntimeCreds(doc);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeRuntimeCreds(encoded), doc);
    assert.deepEqual(decodeRuntimeCreds(JSON.stringify(doc)), doc);
    const tampered = JSON.stringify({ ...doc, masterPk: MASTER_PK });
    assert.throws(() => decodeRuntimeCreds(tampered), (error: Error) => !error.message.includes(MASTER_PK) && /strats deploy/.test(error.message));
    assert.throws(() => decodeRuntimeCreds("not-json"), /not readable/);
  });
});

describe("sessions", () => {
  let home: string;
  const savedHome = process.env.STRATS_HOME;
  before(() => {
    home = mkdtempSync(join(tmpdir(), "strats-session-"));
    process.env.STRATS_HOME = home;
    process.env.STRATS_PASSPHRASE = PASSPHRASE;
    ensureHome();
  });
  after(() => {
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.STRATS_HOME; else process.env.STRATS_HOME = savedHome;
    delete process.env.STRATS_PASSPHRASE;
    delete process.env[RUNTIME_CREDS_ENV];
  });

  it("run on a droplet from the env value alone, with no keystore, and drop the value from the environment", async () => {
    const bot = baseBot();
    process.env[RUNTIME_CREDS_ENV] = encodeRuntimeCreds(buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: bot.gatewayUrl, bot, hyperliquid: { agentPk: AGENT_PK, masterAddress: bot.masterAddress } }));
    const session = await openSession(parseArgs(["run", "--id", "alpha"]), new Prompts());
    assert.equal(process.env[RUNTIME_CREDS_ENV], undefined);
    assert.equal(session.keystore, undefined);
    assert.equal(session.gateway.apiKey, API_KEY);
    assert.equal(loadAgentKey(session), AGENT_PK);
    assert.throws(() => requireKeystore(session, "fund"), /needs the local keystore/);
  });

  it("refuse runtime credentials that belong to another bot", async () => {
    const bot = baseBot();
    process.env[RUNTIME_CREDS_ENV] = encodeRuntimeCreds(buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: bot.gatewayUrl, bot, hyperliquid: { agentPk: AGENT_PK, masterAddress: bot.masterAddress } }));
    await assert.rejects(openSession(parseArgs(["run", "--id", "beta"]), new Prompts()), /belong to bot "alpha"/);
    delete process.env[RUNTIME_CREDS_ENV];
  });

  it("read Polymarket credentials from the keystore and check the signer", async () => {
    const keystore = new Keystore(keysDir());
    keystore.putEntry("theme", KeyRoles.master, MASTER_PK, PASSPHRASE, { address: addressFromPk(MASTER_PK), runtimeEligible: false });
    keystore.putEntry("theme", API_KEY_ROLE, API_KEY, PASSPHRASE, { runtimeEligible: true });
    keystore.putEntry("theme", "polymarket-l2", JSON.stringify(L2), PASSPHRASE, { runtimeEligible: true });
    const funder = "0x00000000000000000000000000000000000000f1";
    saveBot(baseBot({ id: "theme", strategyId: "theme", agentAddress: undefined, polymarket: { signerAddress: addressFromPk(MASTER_PK), funder, signatureType: 3 } }));
    const session = await openSession(parseArgs(["status", "--id", "theme"]), new Prompts());
    assert.deepEqual(loadPolymarketCreds(session), { venue: "polymarket", signerPk: MASTER_PK, funder, signatureType: 3, l2: L2 });

    saveBot(baseBot({ id: "theme", strategyId: "theme", agentAddress: undefined, polymarket: { signerAddress: addressFromPk(AGENT_PK), funder, signatureType: 3 } }));
    const mismatched = await openSession(parseArgs(["status", "--id", "theme"]), new Prompts());
    assert.throws(() => loadPolymarketCreds(mismatched), /does not match/);
  });
});
