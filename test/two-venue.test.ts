// A single-asset key whose settings list Polymarket markets is one bot on two
// venues: the perp on Hyperliquid and the markets on Polymarket, under one key
// and one strats init. A key with no markets is the single-asset bot it always was.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { KeyRoles, Keystore, addressFromPk } from "@quotient-forecasting/cassie-core";
import { parseArgs } from "../src/args.js";
import { assetMarketsForCycle } from "../src/asset-markets.js";
import { fetchAssetMarketsTargets } from "../src/client.js";
import { disclosure } from "../src/commands/deploy.js";
import { describeConfig } from "../src/commands/init.js";
import { isFunded, marketsFundingSettled, nextInitStage, type InitBot } from "../src/install.js";
import { runLoops } from "../src/loop.js";
import { ensureHome, keysDir, marketsStateFile, runtimeStateFile } from "../src/paths.js";
import { ASSET_SOURCE, sourceFor } from "../src/polymarket-source.js";
import { ReportSchema, configuredMarkets, parseAssetMarketsTargets, parseConfig, parseTeamTargets, parseThemeTargets, type AssetMarketsTargetsDoc, type ThemeMarket } from "../src/protocol/index.js";
import { buildReport, mergeFigures, type ReportFigures } from "../src/report.js";
import { buildRuntimeCreds, decodeRuntimeCreds, encodeRuntimeCreds } from "../src/runtime-creds.js";
import { emptyRuntimeState, loadRuntimeState, saveRuntimeState } from "../src/runtime-state.js";
import { POLYMARKET_SIGNER_ROLE, loadPolymarketCreds, openSession, polymarketSignerRole } from "../src/session.js";
import { Prompts, makeSetupContext } from "../src/setup.js";
import { API_KEY_ROLE, BotStateSchema, isPolymarketBot, isTwoVenueBot, marketsStateScope, saveBot, type BotState } from "../src/state.js";

// Built at run time so no key-shaped literal sits in the repository.
const hexKey = (byte: string): string => `0x${byte.repeat(32)}`;
const MASTER_PK = hexKey("a1");
const AGENT_PK = hexKey("b2");
const SIGNER_PK = hexKey("c3");
const PASSPHRASE = ["correct", "horse", "battery"].join("-");
const API_KEY = `qsk_${"test".repeat(3)}`;
const FUNDER = `0x${"f1".repeat(20)}`;
const L2 = { apiKey: "l2-key-id", secret: "l2-secret-value", passphrase: "l2-pass-value" };
const pmAccount = { signerAddress: addressFromPk(SIGNER_PK), funder: FUNDER, signatureType: 3 };
const deployment = { dropletId: 1, host: "203.0.113.5", region: "blr1", size: "s-1vcpu-1gb", version: "0.5.0", deployedAt: "2026-09-19T00:00:00.000Z" };

const account = { positionPct: 10, token: { chainId: 8453, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, split: { buybackPct: 70, keepPct: 30 } };
const market = (over: Partial<ThemeMarket> = {}): ThemeMarket => ({ conditionId: "0xabc", tokenIds: ["111", "222"], outcomes: ["Yes", "No"], side: 0, question: "Will NVDA close above $200?", marketKey: null, ...over });
const stockConfig = (strategy: Record<string, unknown>) => ({
  strategyId: "stock-ls", version: 2, updatedAt: "2026-09-19T00:00:00.000Z",
  config: { v: 1, strategyId: "stock-ls", strategy, account },
});
const targetsDoc = (over: Record<string, unknown> = {}) => ({
  v: 1, strategyId: "stock-ls", asOf: "2026-09-19T12:00:00.000Z", validUntil: "2026-09-19T12:05:00.000Z", mode: "open",
  targets: [{ id: "0xabc:0", venue: "polymarket", conditionId: "0xabc", tokenId: "111", outcome: "Yes", question: "Will NVDA close above $200?", maxPrice: 0.8, takeProfitPrice: 0.99, expiresAt: null, rule: "q", q: 0.85, reason: "Q 85%, market 75%." }],
  closed: [],
  ...over,
});
const parsedTargets = (over: Record<string, unknown> = {}): AssetMarketsTargetsDoc => {
  const parsed = parseAssetMarketsTargets(targetsDoc(over));
  assert.equal(parsed.ok, true);
  return (parsed as { ok: true; value: AssetMarketsTargetsDoc }).value;
};

const twoVenueBot = (over: Partial<BotState> = {}): BotState => ({
  v: 1, id: "nvda", strategyId: "stock-ls", gatewayUrl: "https://quotient-api-gateway.onrender.com", keyPrefix: API_KEY.slice(0, 12),
  masterAddress: addressFromPk(MASTER_PK), agentAddress: addressFromPk(AGENT_PK), polymarket: pmAccount, markets: {}, ceilingPct: 5, createdAt: "2026-09-18T00:00:00.000Z",
  pinned: { token: account.token, split: account.split },
  ...over,
});

describe("a single-asset config", () => {
  it("parses without markets exactly as before, and is a perp-only key", () => {
    const parsed = parseConfig(stockConfig({ assetKey: "company:nvda", direction: "long" }));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(configuredMarkets(parsed.value), []);
    assert.equal(parsed.value.config.strategy.markets, undefined);
    assert.deepEqual(describeConfig(parsed.value).slice(0, 2), ["  Strategy         Single asset, on Hyperliquid", "  Asset            company:nvda"]);
    // An empty list is the same thing.
    const empty = parseConfig(stockConfig({ assetKey: "company:nvda", markets: [] }));
    assert.equal(empty.ok && configuredMarkets(empty.value).length === 0, true);
    if (empty.ok) assert.deepEqual(describeConfig(empty.value).slice(0, 2), ["  Strategy         Single asset, on Hyperliquid", "  Asset            company:nvda"]);
  });

  it("parses with markets in the theme's market shape, and says so", () => {
    const parsed = parseConfig(stockConfig({ assetKey: "company:nvda", direction: "both", markets: [market(), market({ conditionId: "0xdef", tokenIds: ["333", "444"], side: 1 })] }));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(configuredMarkets(parsed.value).length, 2);
    assert.deepEqual(describeConfig(parsed.value).slice(0, 3), [
      "  Strategy         Single asset, on Hyperliquid and Polymarket",
      "  Asset            company:nvda",
      "  Markets          2 on Polymarket, chosen on TokenStrats",
    ]);
  });

  it("refuses more than 40 markets, a bad side, a duplicate, and a market whose two tokens are the same", () => {
    const ok = (markets: unknown): boolean => parseConfig(stockConfig({ assetKey: "company:nvda", markets })).ok;
    assert.equal(ok(Array.from({ length: 40 }, (_, i) => market({ conditionId: `0x${i}` }))), true);
    assert.equal(ok(Array.from({ length: 41 }, (_, i) => market({ conditionId: `0x${i}` }))), false);
    assert.equal(ok([{ ...market(), side: 2 }]), false);
    assert.equal(ok([market(), market()]), false);
    assert.equal(ok([market({ tokenIds: ["111", "111"] })]), false);
    assert.equal(ok("yes"), false);
  });
});

describe("the targets for a single asset's markets", () => {
  it("are the theme document under the single-asset id, and an empty one is valid", () => {
    assert.equal(parseAssetMarketsTargets(targetsDoc()).ok, true);
    assert.equal(parseAssetMarketsTargets(targetsDoc({ targets: [], closed: [] })).ok, true);
    assert.equal(parseAssetMarketsTargets(targetsDoc({ targets: [{ ...targetsDoc().targets[0], id: "nope" }] })).ok, false);
  });

  it("are never taken for a theme or team document, and the reverse", () => {
    assert.equal(parseThemeTargets(targetsDoc()).ok, false);
    assert.equal(parseTeamTargets({ ...targetsDoc(), markets: [] }).ok, false);
    assert.equal(parseAssetMarketsTargets(targetsDoc({ strategyId: "theme" })).ok, false);
    assert.equal(parseAssetMarketsTargets({ ...targetsDoc({ strategyId: "team" }), markets: [] }).ok, false);
  });

  it("are read from the stock-ls targets route with the same key", async () => {
    let asked = "";
    const fetchImpl = (async (url: string | URL | Request) => {
      asked = String(url);
      return new Response(JSON.stringify(targetsDoc({ targets: [] })), { status: 200 });
    }) as typeof fetch;
    const result = await fetchAssetMarketsTargets({ gatewayUrl: "https://gateway.example", apiKey: API_KEY, fetchImpl });
    assert.equal(asked, "https://gateway.example/api/v1/strategies/stock-ls/targets");
    assert.equal(result.ok, true);
  });
});

describe("the local check of a single asset's market targets", () => {
  const yes = market();

  it("passes a target that meets the rule and leaves the side on the bought outcome", () => {
    const cycle = assetMarketsForCycle(parsedTargets(), { direction: "long", markets: [yes] });
    assert.equal(cycle.doc.targets.length, 1);
    assert.equal(cycle.doc.strategyId, "theme");
    assert.deepEqual(cycle.refused, []);
    assert.equal(cycle.markets[0]!.side, 0);
  });

  it("follows the direction: long takes the configured outcome, short the other, both either", () => {
    const buysNo = { targets: [{ ...targetsDoc().targets[0], id: "0xabc:1", tokenId: "222", outcome: "No" }] };
    assert.equal(assetMarketsForCycle(parsedTargets(buysNo), { direction: "long", markets: [yes] }).doc.targets.length, 0);
    assert.match(assetMarketsForCycle(parsedTargets(buysNo), { direction: "long", markets: [yes] }).refused[0]!, /long-only/);
    const short = assetMarketsForCycle(parsedTargets(buysNo), { direction: "short", markets: [yes] });
    assert.equal(short.doc.targets.length, 1);
    assert.equal(short.markets[0]!.side, 1);
    assert.match(assetMarketsForCycle(parsedTargets(), { direction: "short", markets: [yes] }).refused[0]!, /short-only/);
    assert.equal(assetMarketsForCycle(parsedTargets(buysNo), { direction: "both", markets: [yes] }).markets[0]!.side, 1);
    // Saved before directions existed: both.
    assert.equal(assetMarketsForCycle(parsedTargets(buysNo), { markets: [yes] }).doc.targets.length, 1);
  });

  it("never buys a market Q has not forecast, below 70 cents, above 97, or with less than 5 points of edge", () => {
    const refusedFor = (target: Record<string, unknown>): string => {
      const cycle = assetMarketsForCycle(parsedTargets({ targets: [{ ...targetsDoc().targets[0], ...target }] }), { direction: "both", markets: [yes] });
      assert.equal(cycle.doc.targets.length, 0);
      return cycle.refused[0] ?? "";
    };
    assert.match(refusedFor({ q: null }), /Q has not forecast/);
    assert.match(refusedFor({ rule: "market" }), /Q has not forecast/);
    assert.match(refusedFor({ maxPrice: 0.69, q: 0.9 }), /below 0.7/);
    assert.match(refusedFor({ maxPrice: 0.98, q: 1 }), /above 0.97/);
    assert.match(refusedFor({ maxPrice: 0.8, q: 0.84 }), /not 5 points above/);
    // The edges of the rule pass.
    assert.equal(assetMarketsForCycle(parsedTargets({ targets: [{ ...targetsDoc().targets[0], maxPrice: 0.7, q: 0.75 }] }), { markets: [yes] }).doc.targets.length, 1);
    assert.equal(assetMarketsForCycle(parsedTargets({ targets: [{ ...targetsDoc().targets[0], maxPrice: 0.95, q: 1 }] }), { markets: [yes] }).doc.targets.length, 1);
  });

  it("refuses a market the creator did not choose, and keeps every chosen market so a holding can still be sold", () => {
    const stranger = { targets: [{ ...targetsDoc().targets[0], id: "0xother:0", conditionId: "0xother" }], closed: [{ conditionId: "0xabc", tokenId: "111", reason: "Resolved." }] };
    const cycle = assetMarketsForCycle(parsedTargets(stranger), { direction: "long", markets: [yes] });
    assert.equal(cycle.doc.targets.length, 0);
    assert.match(cycle.refused[0]!, /not one of the configured markets/);
    assert.equal(cycle.markets.length, 1);
    assert.equal(cycle.doc.closed.length, 1);
    // Without settings nothing is configured, so nothing is traded.
    assert.equal(ASSET_SOURCE.marketsFor(undefined, parsedTargets()).doc.targets.length, 0);
  });
});

describe("a two-venue bot file", () => {
  it("is a single-asset bot with a Polymarket account; a bot without the mark is unchanged", () => {
    assert.equal(BotStateSchema.safeParse(twoVenueBot()).success, true);
    assert.equal(isTwoVenueBot(twoVenueBot()), true);
    assert.equal(isPolymarketBot(twoVenueBot()), false);
    const plain = twoVenueBot({ markets: undefined, polymarket: undefined });
    assert.equal(isTwoVenueBot(plain), false);
    assert.equal(marketsStateScope(plain), undefined);
    assert.equal(marketsStateScope(twoVenueBot()), "markets");
    // A theme bot is never two-venue, whatever its file says.
    assert.equal(isTwoVenueBot({ strategyId: "theme", markets: {} }), false);
    assert.equal(sourceFor(twoVenueBot()).label, "markets");
    assert.throws(() => sourceFor(plain), /does not trade on Polymarket/);
    // Bot files written by 0.3.0 and 0.4.0 have no such field and still load.
    const { markets: _markets, polymarket: _polymarket, ...old } = twoVenueBot();
    assert.equal(BotStateSchema.safeParse(old).success, true);
  });
});

describe("the init stages of a two-venue bot", () => {
  const stock = (over: Partial<InitBot> = {}): InitBot => ({ strategyId: "stock-ls", markets: {}, ...over });
  const funded = { agentAddress: addressFromPk(AGENT_PK), fundedAt: "2026-09-19T00:00:00.000Z" };

  /** Walk the stages the way init does, applying what each one leaves in the bot file. */
  function walk(opts: { noDeploy?: boolean; skip?: boolean } = {}): string[] {
    const seen: string[] = [];
    let bot: InitBot | undefined;
    for (let step = 0; step < 10; step++) {
      const stage = nextInitStage({ bot, ...(opts.noDeploy ? { noDeploy: true } : {}), polymarketCredsStored: bot?.polymarket !== undefined });
      seen.push(stage);
      if (stage === "done") break;
      if (stage === "setup") bot = stock();
      else if (stage === "account") bot = { ...bot!, polymarket: pmAccount };
      else if (stage === "fund") bot = { ...bot!, ...funded };
      else if (stage === "fund-markets") bot = { ...bot!, markets: opts.skip ? { skippedAt: "2026-09-19T00:00:00.000Z" } : { fundedAt: "2026-09-19T00:00:00.000Z" } };
      else bot = { ...bot!, deployment };
    }
    return seen;
  }

  it("runs one init: the Polymarket account, the perp's funding, Polymarket's funding, then the deploy", () => {
    assert.deepEqual(walk(), ["setup", "account", "fund", "fund-markets", "deploy", "done"]);
    assert.deepEqual(walk({ skip: true }), ["setup", "account", "fund", "fund-markets", "deploy", "done"]);
    assert.deepEqual(walk({ noDeploy: true }), ["setup", "account", "fund", "fund-markets", "done"]);
  });

  it("resumes each step on its own", () => {
    assert.equal(nextInitStage({ bot: stock() }), "account");
    assert.equal(nextInitStage({ bot: stock({ polymarket: pmAccount }), polymarketCredsStored: false }), "account");
    assert.equal(nextInitStage({ bot: stock({ polymarket: pmAccount }) }), "fund");
    assert.equal(nextInitStage({ bot: stock({ polymarket: pmAccount, ...funded }) }), "fund-markets");
    assert.equal(nextInitStage({ bot: stock({ polymarket: pmAccount, ...funded }), noDeploy: true }), "fund-markets");
    assert.equal(nextInitStage({ bot: stock({ polymarket: pmAccount, ...funded, markets: { fundedAt: "x" } }) }), "deploy");
    assert.equal(nextInitStage({ bot: stock({ polymarket: pmAccount, ...funded, markets: { skippedAt: "x" } }) }), "deploy");
    assert.equal(nextInitStage({ bot: stock({ polymarket: pmAccount, ...funded, markets: { skippedAt: "x" }, deployment }) }), "done");
    assert.equal(marketsFundingSettled(stock()), false);
    assert.equal(marketsFundingSettled(stock({ markets: { skippedAt: "x" } })), true);
    // Funding the perp never counts as funding Polymarket, and the reverse.
    assert.equal(isFunded(stock({ polymarket: pmAccount, markets: { fundedAt: "x" } })), false);
  });

  it("picks up the Polymarket side of a bot that was deployed before its key had markets", () => {
    const upgraded = stock({ ...funded, deployment });
    assert.equal(nextInitStage({ bot: upgraded, polymarketCredsStored: false }), "account");
    assert.equal(nextInitStage({ bot: { ...upgraded, polymarket: pmAccount } }), "fund-markets");
    assert.equal(nextInitStage({ bot: { ...upgraded, polymarket: pmAccount, markets: { fundedAt: "x" } } }), "done");
  });

  it("leaves a single-asset bot with no markets on the 0.4.0 path", () => {
    const plain: InitBot = { strategyId: "stock-ls" };
    assert.equal(nextInitStage({ bot: plain, polymarketCredsStored: false }), "fund");
    assert.equal(nextInitStage({ bot: { ...plain, ...funded } }), "deploy");
    assert.equal(nextInitStage({ bot: { ...plain, ...funded, deployment } }), "done");
  });

  it("parses --perp-only and --venue", () => {
    assert.ok(parseArgs(["init", "--perp-only"]).flags.has("perp-only"));
    assert.equal(parseArgs(["fund", "--venue", "polymarket"]).values.venue, "polymarket");
  });
});

describe("the one report of a two-venue bot", () => {
  const perp: ReportFigures = {
    venue: "hyperliquid", equityUsd: 1000, netDepositsUsd: 900, volumeUsd: 5000, openPositions: 1,
    positions: [{ label: "NVIDIA", venue: "hyperliquid", side: "long", sizeUsd: 250, entryPrice: 180, markPrice: 184, pnlUsd: 5.5 }],
    trades: [{ at: "2026-09-19T10:00:00.000Z", label: "NVIDIA", action: "open", sizeUsd: 250, price: 180 }],
    walletAddress: addressFromPk(MASTER_PK),
  };
  const markets: ReportFigures = {
    venue: "polymarket", equityUsd: 200.5, netDepositsUsd: 190, volumeUsd: 80, openPositions: 2,
    positions: [{ label: "Will NVDA close above $200?", venue: "polymarket", side: "Yes", sizeUsd: 40, entryPrice: 0.78, markPrice: 0.8, pnlUsd: 1 }],
    trades: [{ at: "2026-09-19T11:00:00.000Z", label: "Will NVDA close above $200?", action: "buy", sizeUsd: 40, price: 0.78 }],
  };

  it("sums the totals, lists positions and trades from both venues, and stays a hyperliquid report", () => {
    const merged = mergeFigures(perp, markets);
    assert.ok(merged);
    const report = buildReport(merged, "NVDA: opened long.", Date.parse("2026-09-19T12:00:00.000Z"));
    assert.equal(ReportSchema.safeParse(report).success, true);
    assert.equal(report.venue, "hyperliquid");
    assert.equal(report.equityUsd, 1200.5);
    assert.equal(report.netDepositsUsd, 1090);
    assert.equal(report.profitUsd, 110.5);
    assert.equal(report.volumeUsd, 5080);
    assert.equal(report.openPositions, 3);
    assert.deepEqual(report.positions?.map((p) => p.venue), ["hyperliquid", "polymarket"]);
    assert.deepEqual(report.trades?.map((t) => t.action), ["buy", "open"]);
    assert.equal(report.walletAddress, addressFromPk(MASTER_PK));
  });

  it("is not sent when the Polymarket side could not be read, so it never shows a smaller wallet than the bot has", () => {
    assert.equal(mergeFigures(perp, null), null);
  });

  it("keeps the two venues' counters in separate files", () => {
    const home = mkdtempSync(join(tmpdir(), "strats-two-venue-state-"));
    const saved = process.env.STRATS_HOME;
    process.env.STRATS_HOME = home;
    try {
      saveRuntimeState("nvda", { ...emptyRuntimeState(), volumeUsd: 5000 });
      saveRuntimeState("nvda", { ...emptyRuntimeState(), volumeUsd: 80, netDepositsUsd: 190 }, "markets");
      assert.notEqual(runtimeStateFile("nvda"), marketsStateFile("nvda"));
      assert.equal(loadRuntimeState("nvda").volumeUsd, 5000);
      assert.equal(loadRuntimeState("nvda").netDepositsUsd, undefined);
      assert.equal(loadRuntimeState("nvda", "markets").volumeUsd, 80);
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (saved === undefined) delete process.env.STRATS_HOME; else process.env.STRATS_HOME = saved;
    }
  });
});

describe("the two loops of a two-venue bot", () => {
  it("keep running when the other throws every cycle", async () => {
    const lines: string[] = [];
    let perpCycles = 0;
    let marketCycles = 0;
    const code = await runLoops([
      {
        once: false, intervalSec: 0.01, emit: (t) => lines.push(t), stoppedMessage: "perp stopped",
        cycle: async () => {
          perpCycles += 1;
          if (perpCycles === 6) process.emit("SIGTERM");
          return `NVDA  cycle ${perpCycles}`;
        },
      },
      {
        once: false, intervalSec: 0.01, emit: (t) => lines.push(t), stoppedMessage: "markets stopped",
        cycle: async () => {
          marketCycles += 1;
          throw new Error("Polymarket could not be read");
        },
      },
    ]);
    assert.equal(code, 0);
    assert.ok(perpCycles >= 6, "the perp loop kept cycling");
    assert.ok(marketCycles >= 1, "the markets loop ran");
    assert.ok(lines.some((l) => l.includes("Polymarket could not be read")));
    assert.ok(lines.includes("NVDA  cycle 6"));
    assert.ok(lines.includes("perp stopped") && lines.includes("markets stopped"));
  });

  it("with --once, each runs its cycle whatever the other does, and the exit code says one failed", async () => {
    const lines: string[] = [];
    const code = await runLoops([
      { once: true, intervalSec: 1, emit: (t) => lines.push(t), stoppedMessage: "", cycle: async () => { throw new Error("Hyperliquid is down"); } },
      { once: true, intervalSec: 1, emit: (t) => lines.push(t), stoppedMessage: "", cycle: async () => "markets  Nothing to do. 0 positions kept." },
    ]);
    assert.equal(code, 1);
    assert.ok(lines.some((l) => l.startsWith("Error. Hyperliquid is down")));
    assert.ok(lines.includes("markets  Nothing to do. 0 positions kept."));
  });
});

describe("a two-venue bot's credentials", () => {
  it("reach the droplet as both arms, and never carry the Hyperliquid master key or the passphrase", () => {
    const bot = twoVenueBot({ deployment });
    const polymarket = { venue: "polymarket" as const, signerPk: SIGNER_PK, funder: FUNDER, signatureType: 3, l2: L2 };
    const doc = buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: bot.gatewayUrl, bot, hyperliquid: { agentPk: AGENT_PK, masterAddress: bot.masterAddress }, polymarket });
    assert.deepEqual(Object.keys(doc).sort(), ["apiKey", "botState", "gatewayUrl", "hyperliquid", "polymarket"]);
    const wire = Buffer.from(encodeRuntimeCreds(doc), "base64url").toString("utf8");
    assert.ok(!wire.includes(MASTER_PK), "master key");
    assert.ok(!wire.includes(PASSPHRASE), "passphrase");
    assert.deepEqual([...wire.matchAll(/0x[0-9a-fA-F]{64}/g)].map((m) => m[0]).sort(), [AGENT_PK, SIGNER_PK].sort());
    const decoded = decodeRuntimeCreds(encodeRuntimeCreds(doc));
    assert.deepEqual(decoded.botState.markets, {});
    assert.equal(isTwoVenueBot(decoded.botState), true);
    // The perp's key is required; a plain single-asset bot never carries a Polymarket arm.
    assert.throws(() => buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: bot.gatewayUrl, bot, polymarket }), /strats fund/);
    const plain = buildRuntimeCreds({ apiKey: API_KEY, gatewayUrl: bot.gatewayUrl, bot: twoVenueBot({ markets: undefined, polymarket: undefined }), hyperliquid: { agentPk: AGENT_PK, masterAddress: bot.masterAddress }, polymarket });
    assert.equal(plain.polymarket, undefined);
  });

  it("are disclosed plainly before a deploy: the droplet holds the Polymarket signer key", () => {
    const text = disclosure(twoVenueBot()).join(" ");
    assert.match(text, /The droplet holds the Polymarket signer key/);
    assert.match(text, /Hyperliquid trading key, which can place orders and cannot withdraw/);
    assert.match(text, /master key, the keystore file and its passphrase stay on this machine/);
    // A single-asset bot with no markets reads exactly as in 0.4.0.
    assert.deepEqual(disclosure(twoVenueBot({ markets: undefined, polymarket: undefined })), [
      "Sent to the droplet over ssh: the API key; this bot's settings file, which holds addresses, percentages and your choice about publishing the wallet (not published), and nothing secret; the Hyperliquid trading key, which can place orders and cannot withdraw.",
      "The wallet's master key, the keystore file and its passphrase stay on this machine.",
    ]);
  });

  describe("in the keystore", () => {
    let home: string;
    const savedHome = process.env.STRATS_HOME;
    before(() => {
      home = mkdtempSync(join(tmpdir(), "strats-two-venue-"));
      process.env.STRATS_HOME = home;
      process.env.STRATS_PASSPHRASE = PASSPHRASE;
      ensureHome();
    });
    after(() => {
      rmSync(home, { recursive: true, force: true });
      if (savedHome === undefined) delete process.env.STRATS_HOME; else process.env.STRATS_HOME = savedHome;
      delete process.env.STRATS_PASSPHRASE;
    });

    it("sign Polymarket orders with a key of their own, never the Hyperliquid master key", async () => {
      const keystore = new Keystore(keysDir());
      keystore.putEntry("nvda", KeyRoles.master, MASTER_PK, PASSPHRASE, { address: addressFromPk(MASTER_PK), runtimeEligible: false });
      keystore.putEntry("nvda", POLYMARKET_SIGNER_ROLE, SIGNER_PK, PASSPHRASE, { address: addressFromPk(SIGNER_PK), runtimeEligible: true });
      keystore.putEntry("nvda", API_KEY_ROLE, API_KEY, PASSPHRASE, { runtimeEligible: true });
      keystore.putEntry("nvda", "polymarket-l2", JSON.stringify(L2), PASSPHRASE, { runtimeEligible: true });
      saveBot(twoVenueBot());
      const session = await openSession(parseArgs(["status", "--id", "nvda"]), new Prompts());
      assert.equal(polymarketSignerRole(session.bot), POLYMARKET_SIGNER_ROLE);
      assert.equal(polymarketSignerRole({ strategyId: "theme" }), KeyRoles.master);
      assert.deepEqual(loadPolymarketCreds(session), { venue: "polymarket", signerPk: SIGNER_PK, funder: FUNDER, signatureType: 3, l2: L2 });

      // The Polymarket setup flow asks for "master"; a two-venue bot hands it the signer instead.
      const ctx = makeSetupContext("nvda", keystore, PASSPHRASE, new Prompts(), { masterRole: polymarketSignerRole(session.bot) });
      assert.equal(await ctx.getSecret("master"), SIGNER_PK);
      assert.equal(await makeSetupContext("nvda", keystore, PASSPHRASE, new Prompts()).getSecret("master"), MASTER_PK);
    });
  });
});
