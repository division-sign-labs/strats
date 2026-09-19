// Adapted from classy-cassie packages/cli/src/digitalocean.ts (Apache-2.0, Quotient).
// DigitalOcean API v2, over fetch. No doctl dependency: the CLI should work on
// a machine that has never installed anything but node.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { homeDir, writePrivateFile } from "../paths.js";
import type { Prompts } from "../setup.js";

const API = "https://api.digitalocean.com/v2";
const TOKEN_PAGE = "https://cloud.digitalocean.com/account/api/tokens";

export interface Droplet {
  id: number;
  name: string;
  status: "new" | "active" | "off" | "archive";
  region: { slug: string; name: string };
  size_slug: string;
  size: { price_monthly: number };
  created_at: string;
  networks: { v4: Array<{ ip_address: string; type: "public" | "private" }> };
  tags: string[];
}

export class DigitalOceanError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "DigitalOceanError";
  }
}

export const tokenPath = (): string => join(homeDir(), "digitalocean.token");

/** doctl stores its token in a YAML file; read it rather than making the user paste again. */
function tokenFromDoctl(): string | null {
  const path = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "doctl", "config.yaml");
  if (!existsSync(path)) return null;
  const match = readFileSync(path, "utf8").match(/^access-token:\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/m);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value && value.length > 0 ? value : null;
}

const TOKEN_NAMES = ["DIGITALOCEAN_TOKEN", "DIGITALOCEAN_ACCESS_TOKEN", "DO_API_TOKEN"] as const;

/** Environment first, then this program's own file, then cassie's, then doctl's. The token itself is never printed. */
export function findToken(): { token: string; origin: string } | null {
  for (const name of TOKEN_NAMES) {
    const value = process.env[name]?.trim();
    if (value) return { token: value, origin: `the ${name} environment variable` };
  }
  for (const path of [tokenPath(), join(homedir(), ".cassie", "digitalocean.token")]) {
    if (!existsSync(path)) continue;
    const stored = readFileSync(path, "utf8").trim();
    if (stored.length > 0) return { token: stored, origin: path };
  }
  const fromDoctl = tokenFromDoctl();
  return fromDoctl ? { token: fromDoctl, origin: "the doctl config" } : null;
}

export class DigitalOcean {
  constructor(private readonly token: string) {}

  async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) detail = parsed.message;
      } catch {
        // Non-JSON error bodies (proxies, rate limiters) pass through as text.
      }
      throw new DigitalOceanError(response.status, `DigitalOcean ${response.status}: ${detail}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  account(): Promise<{ account: { email: string; status: string; droplet_limit: number } }> {
    return this.call("/account");
  }

  /** Register the public key if the account does not already carry it. */
  async upsertSshKey(name: string, publicKey: string): Promise<number> {
    const { ssh_keys } = await this.call<{ ssh_keys: Array<{ id: number; public_key: string; name: string }> }>("/account/keys?per_page=200");
    const body = publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
    const existing = ssh_keys.find((k) => k.public_key.trim().split(/\s+/).slice(0, 2).join(" ") === body);
    if (existing) return existing.id;
    const created = await this.call<{ ssh_key: { id: number } }>("/account/keys", { method: "POST", body: JSON.stringify({ name, public_key: publicKey.trim() }) });
    return created.ssh_key.id;
  }

  async createDroplet(params: { name: string; region: string; size: string; image: string; sshKeyIds: number[]; userData: string; tags: string[] }): Promise<Droplet> {
    const { droplet } = await this.call<{ droplet: Droplet }>("/droplets", {
      method: "POST",
      body: JSON.stringify({
        name: params.name, region: params.region, size: params.size, image: params.image,
        ssh_keys: params.sshKeyIds, user_data: params.userData, tags: params.tags,
        ipv6: true, monitoring: true, backups: false,
      }),
    });
    return droplet;
  }

  async droplet(id: number): Promise<Droplet> {
    const { droplet } = await this.call<{ droplet: Droplet }>(`/droplets/${id}`);
    return droplet;
  }

  async dropletByName(name: string): Promise<Droplet | null> {
    const { droplets } = await this.call<{ droplets: Droplet[] }>(`/droplets?per_page=200`);
    return droplets.find((d) => d.name === name) ?? null;
  }

  deleteDroplet(id: number): Promise<void> {
    return this.call(`/droplets/${id}`, { method: "DELETE" });
  }

  /** ssh in, everything out. An existing firewall of the same name is replaced whole (PUT resets omitted fields). */
  async upsertFirewall(name: string, dropletId: number): Promise<void> {
    const inbound_rules = [{ protocol: "tcp", ports: "22", sources: { addresses: ["0.0.0.0/0", "::/0"] } }];
    const outbound_rules = [
      { protocol: "tcp", ports: "all", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
      { protocol: "udp", ports: "all", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
      { protocol: "icmp", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
    ];
    const { firewalls } = await this.call<{ firewalls: Array<{ id: string; name: string }> }>("/firewalls?per_page=200");
    const existing = firewalls.find((f) => f.name === name);
    const body = JSON.stringify({ name, droplet_ids: [dropletId], inbound_rules, outbound_rules });
    if (existing) await this.call(`/firewalls/${existing.id}`, { method: "PUT", body });
    else await this.call("/firewalls", { method: "POST", body });
  }

  async deleteFirewall(name: string): Promise<void> {
    const { firewalls } = await this.call<{ firewalls: Array<{ id: string; name: string }> }>("/firewalls?per_page=200");
    const existing = firewalls.find((f) => f.name === name);
    if (existing) await this.call(`/firewalls/${existing.id}`, { method: "DELETE" });
  }
}

export function publicIpv4(droplet: Droplet): string | null {
  return droplet.networks?.v4?.find((n) => n.type === "public")?.ip_address ?? null;
}

/** Find a token that works, or ask for one and save it with owner-only permissions. */
export async function ensureDigitalOceanReady(prompts: Prompts): Promise<{ client: DigitalOcean; email: string }> {
  const found = findToken();
  if (found) {
    const client = new DigitalOcean(found.token);
    try {
      const { account } = await client.account();
      console.log(`DigitalOcean account: ${account.email} (token from ${found.origin})`);
      return { client, email: account.email };
    } catch (error) {
      if (!(error instanceof DigitalOceanError) || error.status !== 401) throw error;
      console.log(`The DigitalOcean token from ${found.origin} was rejected.`);
    }
  }
  console.log("DigitalOcean bills your own account for the droplet.");
  console.log(`Create an API token with read and write scope at ${TOKEN_PAGE}`);
  const token = (await prompts.ask("Paste the token", { secret: true })).trim();
  if (!token) throw new Error("No DigitalOcean token entered.");
  const client = new DigitalOcean(token);
  const { account } = await client.account();
  writePrivateFile(tokenPath(), `${token}\n`);
  console.log(`Token accepted for ${account.email}. Saved to ${tokenPath()} with owner-only permissions.`);
  return { client, email: account.email };
}
