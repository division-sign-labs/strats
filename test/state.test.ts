import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { botFile, botsDir, ensureHome, homeDir, keysDir, writePrivateFile } from "../src/paths.js";
import { loadBot, pinnedDifferences, resolveBotId, saveBot, type BotState } from "../src/state.js";

const pinned = { token: { chainId: 8453, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, split: { buybackPct: 70, keepPct: 30 } };

describe("pinned payout settings", () => {
  it("reports no difference for identical settings", () => {
    assert.deepEqual(pinnedDifferences(pinned, structuredClone(pinned)), []);
  });

  it("ignores checksum casing in a hex address", () => {
    assert.deepEqual(pinnedDifferences(pinned, { ...pinned, token: { chainId: 8453, address: pinned.token.address.toLowerCase() } }), []);
  });

  it("compares a non-hex address exactly", () => {
    const base58 = { ...pinned, token: { chainId: 101, address: "So11111111111111111111111111111111111111112" } };
    assert.equal(pinnedDifferences(base58, { ...base58, token: { chainId: 101, address: base58.token.address.toLowerCase() } }).length, 1);
  });

  it("names a changed token address", () => {
    const differences = pinnedDifferences(pinned, { ...pinned, token: { chainId: 8453, address: "0x000000000000000000000000000000000000dEaD" } });
    assert.equal(differences.length, 1);
    assert.match(differences[0]!, /token address: pinned 0x8335.* server 0x0000/);
  });

  it("names a changed chain", () => {
    assert.match(pinnedDifferences(pinned, { ...pinned, token: { ...pinned.token, chainId: 1 } })[0]!, /token chain: pinned 8453, server 1/);
  });

  it("names both halves of a changed split", () => {
    const differences = pinnedDifferences(pinned, { ...pinned, split: { buybackPct: 10, keepPct: 90 } });
    assert.equal(differences.length, 2);
    assert.match(differences.join(" "), /buyback share: pinned 70%, server 10%/);
    assert.match(differences.join(" "), /kept share: pinned 30%, server 90%/);
  });
});

describe("bot file", () => {
  let home: string;
  const previous = process.env.STRATS_HOME;
  before(() => {
    home = mkdtempSync(join(tmpdir(), "strats-test-"));
    process.env.STRATS_HOME = home;
  });
  after(() => {
    if (previous === undefined) delete process.env.STRATS_HOME;
    else process.env.STRATS_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  const bot: BotState = {
    v: 1, id: "alpha", gatewayUrl: "https://quotient-api-gateway.onrender.com", keyPrefix: "qsk_639e3797",
    masterAddress: "0x1234567890abcdef1234567890abcdef12345678", ceilingPct: 5, pinned, createdAt: "2026-09-18T00:00:00.000Z",
  };

  it("uses STRATS_HOME and creates private directories", () => {
    ensureHome();
    assert.equal(homeDir(), home);
    for (const dir of [home, keysDir(), botsDir()]) assert.equal(statSync(dir).mode & 0o777, 0o700, dir);
  });

  it("round-trips through a 0600 file with no secret fields", () => {
    saveBot(bot);
    assert.equal(statSync(botFile("alpha")).mode & 0o777, 0o600);
    assert.deepEqual(loadBot("alpha"), bot);
    const raw = readFileSync(botFile("alpha"), "utf8");
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["ceilingPct", "createdAt", "gatewayUrl", "id", "keyPrefix", "masterAddress", "pinned", "v"]);
  });

  it("refuses a key prefix longer than 12 characters", () => {
    assert.throws(() => saveBot({ ...bot, keyPrefix: "qsk_639e3797abcdef" }));
  });

  it("refuses a ceiling above 50", () => {
    assert.throws(() => saveBot({ ...bot, ceilingPct: 51 }));
  });

  it("replaces a file atomically and leaves no temp file behind", () => {
    writePrivateFile(join(home, "bots", "note.txt"), "one");
    writePrivateFile(join(home, "bots", "note.txt"), "two");
    assert.equal(readFileSync(join(home, "bots", "note.txt"), "utf8"), "two");
    rmSync(join(home, "bots", "note.txt"));
  });

  it("resolves the only bot, and asks for --id when there are several", () => {
    assert.equal(resolveBotId(undefined), "alpha");
    assert.equal(resolveBotId("beta"), "beta");
    saveBot({ ...bot, id: "beta" });
    assert.throws(() => resolveBotId(undefined), /--id/);
  });

  it("rejects an id that could escape the directory", () => {
    assert.throws(() => botFile("../evil"));
    assert.throws(() => loadBot("UPPER"));
  });
});
