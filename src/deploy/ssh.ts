// Adapted from classy-cassie packages/cli/src/ssh.ts and child-env.ts (Apache-2.0, Quotient).
// ssh is the only way in to a deployed runner: no open port but 22, no bearer
// token. The key lives at ~/.strats/ssh/id_ed25519 (0600) and host keys are
// pinned to ~/.strats/ssh/known_hosts on first contact.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sshDir } from "../paths.js";

export const keyPath = (): string => join(sshDir(), "id_ed25519");
export const knownHostsPath = (): string => join(sshDir(), "known_hosts");

export interface Target {
  host: string;
  user: string;
}

const SYSTEM_NAMES = new Set(["HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TERM", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "SYSTEMROOT", "USERPROFILE", "COMSPEC", "PATHEXT", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"]);

/** Child processes get the system basics and nothing else: no API key, passphrase or token crosses the exec boundary. */
export function restrictedChildEnv(servicePrefixes: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const normalized = name.toUpperCase();
    if (SYSTEM_NAMES.has(normalized) || servicePrefixes.some((prefix) => normalized.startsWith(prefix))) env[name] = value;
  }
  return env;
}

/** Generate the deploy key once. Every bot on this machine shares it. */
export function ensureKeypair(): { publicKey: string; path: string } {
  mkdirSync(sshDir(), { recursive: true, mode: 0o700 });
  const path = keyPath();
  if (!existsSync(path)) {
    const result = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "strats", "-f", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: restrictedChildEnv() });
    if (result.status !== 0) throw new Error(`ssh-keygen failed: ${(result.stderr || result.stdout || "").trim().slice(0, 300)}`);
  }
  return { publicKey: readFileSync(`${path}.pub`, "utf8").trim(), path };
}

/**
 * Record the host's key before the first real connection. Every later call runs
 * with StrictHostKeyChecking=yes against this file, so a swapped host key fails
 * loudly instead of prompting.
 *
 * DigitalOcean reports a droplet `active` before sshd is listening, so this
 * polls: a keyscan against a booting droplet returns nothing, not an error.
 */
export async function pinHostKey(host: string, attempts = 40, intervalMs = 3_000): Promise<void> {
  mkdirSync(sshDir(), { recursive: true, mode: 0o700 });
  const path = knownHostsPath();
  if (existsSync(path) && readFileSync(path, "utf8").includes(`${host} `)) return;
  for (let i = 0; i < attempts; i++) {
    const result = spawnSync("ssh-keyscan", ["-t", "ed25519", "-T", "10", host], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: restrictedChildEnv(), timeout: 20_000 });
    const keys = (result.stdout ?? "").split("\n").filter((line) => line.startsWith(host));
    if (keys.length > 0) {
      appendFileSync(path, `${keys.join("\n")}\n`, { mode: 0o600 });
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Could not read the host key for ${host} after ${attempts} tries. The droplet never started sshd.`);
}

export function forgetHostKey(host: string): void {
  const path = knownHostsPath();
  if (!host || !existsSync(path)) return;
  spawnSync("ssh-keygen", ["-R", host, "-f", path], { stdio: "ignore", env: restrictedChildEnv() });
}

function baseOptions(): string[] {
  return ["-i", keyPath(), "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHostsPath()}`, "-o", "ConnectTimeout=10", "-o", "BatchMode=yes"];
}

export function sshArgs(target: Target, extra: string[] = []): string[] {
  return [...baseOptions(), ...extra, `${target.user}@${target.host}`];
}

export interface ExecResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run one command on the droplet. `stdin` never appears in argv or the process list. Always time-boxed. */
export function sshExec(target: Target, command: string, stdin?: string, options: { timeoutMs?: number } = {}): ExecResult {
  const result = spawnSync("ssh", [...sshArgs(target), "--", command], {
    encoding: "utf8",
    input: stdin ?? "",
    stdio: ["pipe", "pipe", "pipe"],
    env: restrictedChildEnv(["SSH_"]),
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeoutMs ?? 120_000,
  });
  const spawnFailure = result.error ? `ssh failed: ${result.error.message}` : "";
  return { ok: result.status === 0, code: result.status, stdout: result.stdout ?? "", stderr: [result.stderr ?? "", spawnFailure].filter(Boolean).join("\n") };
}

export function sshExecOrThrow(target: Target, command: string, stdin?: string, options: { timeoutMs?: number } = {}): string {
  const result = sshExec(target, command, stdin, options);
  if (!result.ok) throw new Error(`ssh ${target.user}@${target.host}: ${(result.stderr || result.stdout).trim().slice(0, 400)}`);
  return result.stdout;
}

/** Copy one local file to the droplet. */
export function scpTo(target: Target, localPath: string, remotePath: string): void {
  const result = spawnSync("scp", [...baseOptions(), "-q", localPath, `${target.user}@${target.host}:${remotePath}`], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: restrictedChildEnv(["SSH_"]), timeout: 300_000,
  });
  if (result.status !== 0) throw new Error(`scp to ${target.host} failed: ${(result.stderr || result.error?.message || "").trim().slice(0, 300)}`);
}

/** Hand the terminal over, for `strats logs --follow`. */
export function sshInteractive(target: Target, command: string): Promise<number> {
  const args = [...sshArgs(target, ["-t", "-o", "BatchMode=no"]), "--", command];
  return new Promise((resolve) => {
    const child = spawn("ssh", args, { stdio: "inherit", env: restrictedChildEnv(["SSH_"]) });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}
