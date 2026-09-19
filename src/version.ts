// The package's own version and root, read from the package.json that ships next to dist.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function packageRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

export function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
  return manifest.version ?? "unknown";
}
