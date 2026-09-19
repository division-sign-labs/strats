import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "../src/args.js";
import { READY_MARKER, installRunnerCommand, installTarballCommand, renderCloudInit, renderUnit } from "../src/deploy/cloud-init.js";
import { remoteWriteCommand } from "../src/deploy/remote-write.js";
import { restrictedChildEnv } from "../src/deploy/ssh.js";
import { disclosure, monthlyCost } from "../src/commands/deploy.js";
import type { BotState } from "../src/state.js";

/** Anything shaped like a key, a token or a credential assignment. */
const SECRET_PATTERNS = [/qsk_[A-Za-z0-9_-]{8,}/, /0x[0-9a-fA-F]{64}/, /dop_v1_[0-9a-f]+/, /STRATS_RUNTIME_CREDS\s*=/, /STRATS_PASSPHRASE/, /PRIVATE KEY/, /passphrase/i, /api[_-]?key/i, /secret\s*[:=]/i, /[A-Za-z0-9+/_-]{60,}/];

describe("cloud-init", () => {
  for (const tarball of [false, true]) {
    it(`contains nothing secret-looking (${tarball ? "tarball" : "npm"} install)`, () => {
      const text = renderCloudInit({ runnerVersion: "0.2.0", ...(tarball ? { tarball: true } : {}) });
      for (const pattern of SECRET_PATTERNS) assert.doesNotMatch(text, pattern);
    });
  }

  it("is cloud-config that installs node, the pinned runner, a firewall for ssh only, and the ready marker last", () => {
    const text = renderCloudInit({ runnerVersion: "0.2.0" });
    assert.ok(text.startsWith("#cloud-config\n"));
    assert.match(text, /nodesource\.com\/setup_2[2-9]\.x/);
    assert.match(text, /npm install --global --omit=dev --no-audit --no-fund @quotient-forecasting\/strats@0\.2\.0/);
    assert.match(text, /ufw default deny incoming; ufw default allow outgoing; ufw allow 22\/tcp/);
    assert.match(text, /PasswordAuthentication no/);
    assert.ok(text.trimEnd().endsWith(`chown strats:strats ${READY_MARKER}" ]`));
  });

  it("skips the npm install when the runner arrives as a tarball", () => {
    assert.doesNotMatch(renderCloudInit({ runnerVersion: "0.2.0", tarball: true }), /npm install/);
  });

  it("renders a unit that restarts, runs as its own user, and reads credentials only from the env file", () => {
    const unit = renderUnit("0.2.0");
    assert.match(unit, /^ExecStart=\/usr\/bin\/strats run --id %i$/m);
    assert.match(unit, /^Restart=always$/m);
    assert.match(unit, /^User=strats$/m);
    assert.match(unit, /^EnvironmentFile=\/etc\/strats\/%i\.env$/m);
    assert.match(unit, /^Environment=STRATS_HOME=\/var\/lib\/strats$/m);
    assert.match(unit, /^NoNewPrivileges=true$/m);
  });

  it("refuses shell metacharacters in a version, a tarball path, or a remote path", () => {
    assert.throws(() => installRunnerCommand("0.2.0; rm -rf /"));
    assert.throws(() => installTarballCommand("/tmp/x.tgz; id"));
    assert.throws(() => installTarballCommand("/etc/x.tgz"));
    assert.throws(() => remoteWriteCommand("/etc/strats/a b.env", "0600", "strats:strats"));
    assert.equal(installTarballCommand("/tmp/quotient-forecasting-strats-0.2.0.tgz").endsWith("/tmp/quotient-forecasting-strats-0.2.0.tgz"), true);
  });

  it("writes a remote file from stdin and moves it into place last", () => {
    const command = remoteWriteCommand("/etc/strats/alpha.env", "0600", "strats:strats");
    assert.match(command, /^umask 077 && cat > '\/etc\/strats\/alpha\.env\.tmp'/);
    assert.ok(command.endsWith("mv '/etc/strats/alpha.env.tmp' '/etc/strats/alpha.env'"));
  });
});

describe("deploy", () => {
  const bot: BotState = {
    v: 1, id: "alpha", strategyId: "stock-ls", gatewayUrl: "https://quotient-api-gateway.onrender.com", keyPrefix: "qsk_639e3797",
    masterAddress: "0x1234567890abcdef1234567890abcdef12345678", ceilingPct: 5, createdAt: "2026-09-18T00:00:00.000Z",
    pinned: { token: { chainId: 8453, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, split: { buybackPct: 70, keepPct: 30 } },
  };

  it("says what reaches the droplet for each venue", () => {
    assert.match(disclosure(bot).join(" "), /trading key, which can place orders and cannot withdraw/);
    assert.match(disclosure(bot).join(" "), /master key, the keystore file and its passphrase stay on this machine/);
    const theme = disclosure({ ...bot, strategyId: "theme" }).join(" ");
    assert.match(theme, /Polymarket wallet key/);
    assert.match(theme, /Whoever controls the droplet controls the funds/);
  });

  it("prints the monthly cost of a known size", () => {
    assert.match(monthlyCost("s-1vcpu-1gb"), /^\$6 per month/);
    assert.doesNotMatch(monthlyCost("c-64"), /\$/);
  });

  it("parses the deploy flags", () => {
    const args = parseArgs(["deploy", "--id", "alpha", "--region", "fra1", "--size=s-1vcpu-2gb", "--from-tarball", "--dry-run", "-y"]);
    assert.equal(args.command, "deploy");
    assert.deepEqual(args.values, { id: "alpha", region: "fra1", size: "s-1vcpu-2gb" });
    assert.deepEqual([...args.flags].sort(), ["dry-run", "from-tarball", "yes"]);
  });

  it("passes no secret environment variable to ssh, scp or npm", () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { STRATS_PASSPHRASE: "hunter2hunter2", STRATS_API_KEY: "qsk_test", DIGITALOCEAN_TOKEN: "dop_v1_x", STRATS_RUNTIME_CREDS: "x", SSH_AUTH_SOCK: "/tmp/agent" });
      const env = restrictedChildEnv(["SSH_"]);
      for (const name of ["STRATS_PASSPHRASE", "STRATS_API_KEY", "DIGITALOCEAN_TOKEN", "STRATS_RUNTIME_CREDS"]) assert.equal(env[name], undefined, name);
      assert.equal(env.SSH_AUTH_SOCK, "/tmp/agent");
      assert.equal(env.PATH, process.env.PATH);
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  });
});
