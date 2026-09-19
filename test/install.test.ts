import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "../src/args.js";
import { isFunded, nextInitStage, type InitBot } from "../src/install.js";

const ADDRESS = `0x${"a1".repeat(20)}`;
const stock = (over: Partial<InitBot> = {}): InitBot => ({ strategyId: "stock-ls", ...over });
const theme = (over: Partial<InitBot> = {}): InitBot => ({ strategyId: "theme", ...over });
const account = { signerAddress: ADDRESS, funder: `0x${"f1".repeat(20)}`, signatureType: 3 };
const deployment = { dropletId: 1, host: "203.0.113.5", region: "blr1", size: "s-1vcpu-1gb", version: "0.3.0", deployedAt: "2026-09-19T00:00:00.000Z" };

/** Walk the stages the way init does, applying what each one leaves in the bot file. */
function walk(start: InitBot | undefined, strategyId: InitBot["strategyId"], opts: { noDeploy?: boolean } = {}): string[] {
  const seen: string[] = [];
  let bot = start;
  for (let step = 0; step < 10; step++) {
    const stage = nextInitStage({ bot, ...opts, polymarketCredsStored: bot?.polymarket !== undefined });
    seen.push(stage);
    if (stage === "done") break;
    if (stage === "setup") bot = { strategyId };
    else if (stage === "account") bot = { ...bot!, polymarket: account };
    else if (stage === "fund") bot = { ...bot!, fundedAt: "2026-09-19T00:00:00.000Z", ...(strategyId === "stock-ls" ? { agentAddress: ADDRESS } : {}) };
    else bot = { ...bot!, deployment };
  }
  return seen;
}

describe("the init stage machine", () => {
  it("carries a single-asset bot from nothing to a droplet in one pass", () => {
    assert.deepEqual(walk(undefined, "stock-ls"), ["setup", "fund", "deploy", "done"]);
  });

  it("adds the Polymarket account for a theme bot, before funding", () => {
    assert.deepEqual(walk(undefined, "theme"), ["setup", "account", "fund", "deploy", "done"]);
  });

  it("stops after funding with --no-deploy, for both kinds", () => {
    assert.deepEqual(walk(undefined, "stock-ls", { noDeploy: true }), ["setup", "fund", "done"]);
    assert.deepEqual(walk(undefined, "theme", { noDeploy: true }), ["setup", "account", "fund", "done"]);
    assert.equal(nextInitStage({ bot: stock({ fundedAt: "2026-09-19T00:00:00.000Z" }), noDeploy: true }), "done");
  });

  it("resumes at the first unfinished stage and never goes back to creating the wallet", () => {
    assert.equal(nextInitStage({ bot: stock() }), "fund");
    assert.equal(nextInitStage({ bot: stock({ agentAddress: ADDRESS, fundedAt: "2026-09-19T00:00:00.000Z" }) }), "deploy");
    assert.equal(nextInitStage({ bot: stock({ agentAddress: ADDRESS, fundedAt: "2026-09-19T00:00:00.000Z", deployment }) }), "done");
    assert.equal(nextInitStage({ bot: theme() }), "account");
    assert.equal(nextInitStage({ bot: theme({ polymarket: account }) }), "fund");
    assert.equal(nextInitStage({ bot: theme({ polymarket: account, fundedAt: "2026-09-19T00:00:00.000Z" }) }), "deploy");
    for (const bot of [stock(), theme(), theme({ polymarket: account }), stock({ fundedAt: "x", deployment })]) {
      assert.notEqual(nextInitStage({ bot }), "setup");
      assert.notEqual(nextInitStage({ bot, noDeploy: true }), "setup");
    }
    // A stopped run that is started again with --no-deploy still funds first.
    assert.equal(nextInitStage({ bot: stock(), noDeploy: true }), "fund");
  });

  it("finishes a deploy that was stopped after the droplet was created, instead of calling it done", () => {
    const halfway = stock({ agentAddress: ADDRESS, fundedAt: "2026-09-19T00:00:00.000Z", deployment: { ...deployment, pending: true } });
    assert.equal(nextInitStage({ bot: halfway }), "deploy");
    assert.equal(nextInitStage({ bot: halfway, noDeploy: true }), "done");
    assert.equal(nextInitStage({ bot: theme({ polymarket: account, deployment: { ...deployment, pending: true } }) }), "deploy");
    // A droplet deployed before 0.3.0 has no such mark and is done.
    assert.equal(nextInitStage({ bot: stock({ agentAddress: ADDRESS, deployment }) }), "done");
  });

  it("repeats the account stage when the Polymarket credentials never reached the keystore", () => {
    assert.equal(nextInitStage({ bot: theme({ polymarket: account }), polymarketCredsStored: false }), "account");
    assert.equal(nextInitStage({ bot: theme({ polymarket: account }), polymarketCredsStored: true }), "fund");
    // The keystore has no such entry for a single-asset bot, and that is not a reason to stop it.
    assert.equal(nextInitStage({ bot: stock(), polymarketCredsStored: false }), "fund");
  });

  it("reads the settings again only with --force, and then continues from what is true", () => {
    const funded = stock({ agentAddress: ADDRESS, fundedAt: "2026-09-19T00:00:00.000Z" });
    assert.equal(nextInitStage({ bot: funded, force: true }), "setup");
    assert.equal(nextInitStage({ bot: funded }), "deploy");
  });

  it("treats bots funded before 0.3.0 as funded: an approved trading key, or a droplet already running", () => {
    assert.equal(isFunded(stock({ agentAddress: ADDRESS })), true);
    assert.equal(isFunded(stock()), false);
    // A theme bot has no trading key, so an address there proves nothing.
    assert.equal(isFunded(theme({ polymarket: account, agentAddress: ADDRESS })), false);
    assert.equal(isFunded(theme({ polymarket: account, deployment })), true);
    assert.equal(nextInitStage({ bot: theme({ polymarket: account, deployment }) }), "done");
  });
});

describe("init flags", () => {
  it("parses --no-deploy, --region and -y, and refuses a value on --no-deploy", () => {
    const args = parseArgs(["init", "--key", "qsk_abcdefgh", "--no-deploy", "--region", "fra1", "-y"]);
    assert.equal(args.command, "init");
    assert.ok(args.flags.has("no-deploy") && args.flags.has("yes"));
    assert.equal(args.values.region, "fra1");
    assert.throws(() => parseArgs(["init", "--no-deploy=true"]), /does not take a value/);
  });
});
