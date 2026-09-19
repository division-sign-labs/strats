// Gateway client. Config and targets come down with GETs; the only thing sent
// up is the display-only report. Never throws: every failure comes back as a
// typed result so the run loop can hold instead of crashing.
import {
  STRATEGY_ID, encodeReport, THEME_STRATEGY_ID, parseConfig, parseTarget, parseThemeConfig, parseThemeTargets,
  type AnyConfigDoc, type ConfigDoc, type ParseResult, type Report, type StrategyId, type TargetDoc, type ThemeConfigDoc, type ThemeTargetsDoc,
} from "./protocol/index.js";

export const DEFAULT_GATEWAY_URL = "https://quotient-api-gateway.onrender.com";
const TIMEOUT_MS = 10_000;

export type FetchFailureKind = "auth" | "not_configured" | "unavailable" | "invalid";
export type FetchResult<T> = { ok: true; value: T } | { ok: false; kind: FetchFailureKind; message: string; status?: number };

export interface GatewayOptions {
  gatewayUrl: string;
  apiKey: string;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

/** The key travels in a header, so refuse plain http except to this machine. */
export function normalizeGatewayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Gateway URL is not valid: ${raw}`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("Gateway URL must use https, because the API key is sent with every request.");
  }
  if (url.username || url.password) throw new Error("Gateway URL must not contain credentials.");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

async function getJson<T>(opts: GatewayOptions, path: string, parse: (input: unknown) => ParseResult<T>): Promise<FetchResult<T>> {
  const doFetch = opts.fetchImpl ?? fetch;
  let response: Response | undefined;
  let networkError = "";
  // One retry, and only when no response arrived at all.
  for (let attempt = 0; attempt < 2 && !response; attempt++) {
    try {
      response = await doFetch(`${opts.gatewayUrl}${path}`, {
        method: "GET",
        headers: { "x-quotient-api-key": opts.apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
    } catch (error) {
      networkError = error instanceof Error && error.name === "TimeoutError" ? "request timed out after 10 seconds" : "network error";
    }
  }
  if (!response) return { ok: false, kind: "unavailable", message: `Could not reach the gateway (${networkError}).` };

  if (response.status !== 200) {
    const code = await errorCode(response);
    if (response.status === 401) return { ok: false, kind: "auth", status: 401, message: "The API key is unknown, revoked or expired." };
    if (response.status === 403) return { ok: false, kind: "auth", status: 403, message: "The API key is not allowed to use this strategy." };
    if (response.status === 404 && code === "not_configured") {
      return { ok: false, kind: "not_configured", message: "This key has no saved settings yet. Save the strategy settings on TokenStrats first." };
    }
    return { ok: false, kind: "unavailable", message: `The gateway answered ${response.status}${code ? ` (${code})` : ""}.` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, kind: "invalid", message: "The gateway answer was not JSON." };
  }
  const parsed = parse(body);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, kind: "invalid", message: `The gateway answer did not match the protocol (${parsed.reason}).` };
}

/** Best-effort read of a short machine code from an error body. Never echoes arbitrary text. */
async function errorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as Record<string, unknown> | null;
    const candidate = body && typeof body === "object" ? body.error ?? body.code : undefined;
    const code = typeof candidate === "string" ? candidate
      : candidate && typeof candidate === "object" && typeof (candidate as Record<string, unknown>).code === "string" ? String((candidate as Record<string, unknown>).code) : "";
    return /^[a-z0-9_.-]{1,64}$/i.test(code) ? code : "";
  } catch {
    return "";
  }
}

export function fetchConfig(opts: GatewayOptions): Promise<FetchResult<ConfigDoc>> {
  return getJson(opts, `/api/v1/strategies/${STRATEGY_ID}/config`, parseConfig);
}

export function fetchTarget(opts: GatewayOptions): Promise<FetchResult<TargetDoc>> {
  return getJson(opts, `/api/v1/strategies/${STRATEGY_ID}/target`, parseTarget);
}

export function fetchThemeConfig(opts: GatewayOptions): Promise<FetchResult<ThemeConfigDoc>> {
  return getJson(opts, `/api/v1/strategies/${THEME_STRATEGY_ID}/config`, parseThemeConfig);
}

export function fetchThemeTargets(opts: GatewayOptions): Promise<FetchResult<ThemeTargetsDoc>> {
  return getJson(opts, `/api/v1/strategies/${THEME_STRATEGY_ID}/targets`, parseThemeTargets);
}

/**
 * A key belongs to one strategy, and only the gateway knows which. Ask for the
 * single-asset settings first; a 403 means the key belongs to the other strategy.
 */
export async function discoverConfig(opts: GatewayOptions): Promise<FetchResult<AnyConfigDoc>> {
  const stock = await fetchConfig(opts);
  if (stock.ok || stock.kind !== "auth" || stock.status !== 403) return stock;
  return fetchThemeConfig(opts);
}

/**
 * Send the display-only report. One attempt, short timeout, never throws. The
 * answer is not read beyond its status, and nothing the server says here can
 * change what the runner does. A report that does not match the contract, or
 * is larger than the gateway accepts, is dropped here and never sent.
 */
export async function postReport(opts: GatewayOptions, strategyId: StrategyId, report: Report): Promise<{ ok: true } | { ok: false; message: string; status?: number; dropped?: true }> {
  const body = encodeReport(report);
  if (!body.ok) return { ok: false, dropped: true, message: body.reason };
  try {
    const response = await (opts.fetchImpl ?? fetch)(`${opts.gatewayUrl}/api/v1/strategies/${strategyId}/reports`, {
      method: "POST",
      headers: { "x-quotient-api-key": opts.apiKey, "content-type": "application/json", accept: "application/json" },
      body: body.value,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
    return response.status >= 200 && response.status < 300 ? { ok: true } : { ok: false, status: response.status, message: `the gateway answered ${response.status}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error && error.name === "TimeoutError" ? "request timed out" : "network error" };
  }
}
