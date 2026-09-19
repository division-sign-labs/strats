// Everything the runner keeps on disk lives under ~/.strats (or STRATS_HOME).
// Directories are 0700 and files are 0600, written atomically.
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** Same rule as the keystore: lowercase letters, digits and dashes, at most 32 characters. */
export const BOT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const DEFAULT_BOT_ID = "strats";

export function assertBotId(id: string): string {
  if (!BOT_ID_RE.test(id)) throw new Error("Bot id must be lowercase letters, digits and dashes, start with a letter or digit, and be at most 32 characters.");
  return id;
}

export function homeDir(): string {
  return process.env.STRATS_HOME?.trim() || join(homedir(), ".strats");
}
export const keysDir = (): string => join(homeDir(), "keys");
export const botsDir = (): string => join(homeDir(), "bots");
export const logsDir = (): string => join(homeDir(), "logs");
export const botFile = (id: string): string => join(botsDir(), `${assertBotId(id)}.json`);
export const logFile = (id: string): string => join(logsDir(), `${assertBotId(id)}.log`);

/** mkdir honors the umask and ignores existing directories, so set the mode explicitly. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export function ensureHome(): void {
  for (const dir of [homeDir(), keysDir(), botsDir(), logsDir()]) ensurePrivateDir(dir);
}

/** Write to a private temp file, fsync, then rename over the destination. */
export function writePrivateFile(path: string, content: string): void {
  const dir = dirname(path);
  ensurePrivateDir(dir);
  const temporary = join(dir, `.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    if (process.platform !== "win32") {
      const dirFd = openSync(dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function listBotIds(): string[] {
  if (!existsSync(botsDir())) return [];
  return readdirSync(botsDir())
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .map((name) => name.slice(0, -".json".length))
    .filter((id) => BOT_ID_RE.test(id))
    .sort();
}

/** Append one line to the bot's private log. A logging failure never stops the loop. */
export function appendLog(id: string, line: string): void {
  try {
    ensurePrivateDir(logsDir());
    appendFileSync(logFile(id), `${line}\n`, { mode: 0o600 });
  } catch {
    // The terminal line was already printed.
  }
}
