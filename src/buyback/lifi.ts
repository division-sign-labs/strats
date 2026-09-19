// LI.FI finds the route from the withdrawn dollars to the pinned token and
// returns a transaction to sign. The calldata is opaque to us, so every quote
// is checked on its envelope, and a quote that fails any check is rejected,
// never adjusted: the chains, tokens, amount and addresses must be ours, the
// spender and the target must be the pinned LI.FI contract, the transaction
// must carry no native value, and the promised minimum must clear the floor.
// The allowance is exactly one payout, which caps what a bad route could take.
import { z } from "zod";

export const LIFI_API = "https://li.quest/v1";
const TIMEOUT_MS = 30_000;

/**
 * The LI.FI Diamond, per source chain. Confirmed on 2026-09-19 against LI.FI's own
 * published deployments, "LiFiDiamond" in
 * https://github.com/lifinance/contracts/blob/main/deployments/arbitrum.json and
 * https://github.com/lifinance/contracts/blob/main/deployments/polygon.json
 * A quote that names any other spender or target is rejected.
 */
export const LIFI_DIAMOND: Readonly<Record<number, string>> = {
  42161: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
  137: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
};

const numeric = z.string().regex(/^[0-9]+$/);
const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const token = z.object({ address: z.string().min(1), chainId: z.number().int(), symbol: z.string().max(40).catch("token"), decimals: z.number().int().min(0).max(36) });
const usdText = z.union([z.string(), z.number()]).optional();

export const QuoteSchema = z.object({
  tool: z.string().max(80).catch("unknown"),
  action: z.object({
    fromChainId: z.number().int(), toChainId: z.number().int(),
    fromToken: token, toToken: token,
    fromAmount: numeric,
    fromAddress: z.string().min(1), toAddress: z.string().min(1),
    slippage: z.number(),
  }),
  estimate: z.object({
    approvalAddress: z.string().min(1),
    toAmount: numeric, toAmountMin: numeric,
    fromAmountUSD: usdText, toAmountUSD: usdText,
    executionDuration: z.number().nonnegative().catch(0),
    feeCosts: z.array(z.object({ name: z.string().max(80).catch("fee"), amountUSD: usdText, included: z.boolean().catch(true) })).catch([]),
    gasCosts: z.array(z.object({ amount: numeric.catch("0"), amountUSD: usdText, token: z.object({ symbol: z.string().max(20).catch("") }).catch({ symbol: "" }) })).catch([]),
  }),
  includedSteps: z.array(z.object({ type: z.string().catch(""), tool: z.string().max(80).catch("") })).catch([]),
  transactionRequest: z.object({
    to: z.string().min(1), from: z.string().optional(), chainId: z.number().int(),
    data: hex, value: z.union([hex, numeric]).optional(),
    gasLimit: z.union([hex, numeric]).optional(), gasPrice: z.union([hex, numeric]).optional(),
  }),
});
export type Quote = z.infer<typeof QuoteSchema>;

export interface QuoteRequest {
  fromChainId: number;
  toChainId: number;
  fromToken: string;
  toToken: string;
  /** Units of the source token. */
  fromAmount: bigint;
  fromAddress: string;
  toAddress: string;
  /** Percent, for example 1. */
  slippagePct: number;
}

export type QuoteFailure = { ok: false; kind: "no-route" | "unavailable" | "invalid"; message: string };
export type QuoteResult = { ok: true; quote: Quote } | QuoteFailure;

export function quoteUrl(request: QuoteRequest): string {
  const query = new URLSearchParams({
    fromChain: String(request.fromChainId), toChain: String(request.toChainId),
    fromToken: request.fromToken, toToken: request.toToken, fromAmount: request.fromAmount.toString(),
    fromAddress: request.fromAddress, toAddress: request.toAddress,
    slippage: String(request.slippagePct / 100), integrator: "strats",
  });
  return `${LIFI_API}/quote?${query.toString()}`;
}

/** A short, safe sentence from an error body. Never echoes more than 160 characters. */
async function errorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === "string" ? body.message.replace(/\s+/g, " ").slice(0, 160) : "";
  } catch {
    return "";
  }
}

export async function fetchQuote(request: QuoteRequest, fetchImpl: typeof fetch = fetch): Promise<QuoteResult> {
  let response: Response;
  try {
    response = await fetchImpl(quoteUrl(request), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  } catch {
    return { ok: false, kind: "unavailable", message: "LI.FI could not be reached." };
  }
  if (response.status === 404) return { ok: false, kind: "no-route", message: `LI.FI found no route for this swap. ${await errorText(response)}`.trim() };
  if (response.status !== 200) {
    const text = await errorText(response);
    return { ok: false, kind: response.status === 400 ? "no-route" : "unavailable", message: `LI.FI answered ${response.status}${text ? `: ${text}` : "."}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, kind: "invalid", message: "LI.FI's answer was not JSON." };
  }
  const parsed = QuoteSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, kind: "invalid", message: `LI.FI's quote is missing a field this program checks (${issue ? issue.path.join(".") : "unknown"}).` };
  }
  return { ok: true, quote: parsed.data };
}

export interface QuoteExpectation extends QuoteRequest {
  /** Percent. */
  maxImpactPct: number;
  /** When set, the quote must promise at least this many token units. */
  floorMinOut?: bigint;
}

const sameAddress = (a: string | undefined, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const number = (value: string | number | undefined): number => (value === undefined ? Number.NaN : Number(value));

/** Price impact in percent, by LI.FI's own dollar figures. NaN when they are missing. */
export function priceImpactPct(quote: Quote): number {
  const from = number(quote.estimate.fromAmountUSD);
  const to = number(quote.estimate.toAmountUSD);
  if (!(from > 0) || !Number.isFinite(to) || to < 0) return Number.NaN;
  return ((from - to) / from) * 100;
}

/** Every check that failed, in plain words. An empty list means the quote may be used. */
export function checkQuote(quote: Quote, expect: QuoteExpectation): string[] {
  const failures: string[] = [];
  const diamond = LIFI_DIAMOND[expect.fromChainId];
  const { action, estimate, transactionRequest: tx } = quote;
  if (!diamond) return [`there is no pinned LI.FI contract for chain ${expect.fromChainId}`];

  if (action.fromChainId !== expect.fromChainId || action.fromToken.chainId !== expect.fromChainId) failures.push("the quote starts on a different chain");
  if (!sameAddress(action.fromToken.address, expect.fromToken)) failures.push("the quote spends a different token");
  if (action.fromAmount !== expect.fromAmount.toString()) failures.push("the quote is for a different amount");
  if (action.toChainId !== expect.toChainId || action.toToken.chainId !== expect.toChainId) failures.push("the quote ends on a different chain than the pinned token's");
  if (!sameAddress(action.toToken.address, expect.toToken)) failures.push("the quote buys a different token than the pinned one");
  if (!sameAddress(action.fromAddress, expect.fromAddress)) failures.push("the quote spends from a different wallet");
  if (!sameAddress(action.toAddress, expect.toAddress)) failures.push("the quote delivers to a different address");
  if (!sameAddress(estimate.approvalAddress, diamond)) failures.push("the quote asks to approve a contract that is not the pinned LI.FI contract");
  if (!sameAddress(tx.to, diamond)) failures.push("the transaction goes to a contract that is not the pinned LI.FI contract");
  if (tx.from !== undefined && !sameAddress(tx.from, expect.fromAddress)) failures.push("the transaction is written for a different sender");
  if (tx.chainId !== expect.fromChainId) failures.push("the transaction is for a different chain");
  if (tx.data.length <= 2) failures.push("the transaction carries no call");
  let value: bigint | null = null;
  try {
    value = BigInt(tx.value ?? "0x0");
  } catch {
    value = null;
  }
  if (value !== 0n) failures.push("the transaction would also send the wallet's gas coin");
  const minOut = BigInt(estimate.toAmountMin);
  if (minOut <= 0n) failures.push("the quote promises nothing");
  if (expect.floorMinOut !== undefined && minOut < expect.floorMinOut) failures.push("the price moved: the quote now promises less than the least you agreed to");
  const impact = priceImpactPct(quote);
  if (!Number.isFinite(impact)) failures.push("LI.FI gave no dollar figures, so the price impact cannot be checked");
  else if (impact > expect.maxImpactPct) failures.push(`the price impact is ${impact.toFixed(1)}%, above the limit of ${expect.maxImpactPct}%`);
  if (Math.abs(action.slippage - expect.slippagePct / 100) > 1e-9) failures.push("the quote allows a different slippage than was asked for");
  return failures;
}

/** 98% of the quoted minimum: the least a later quote may promise before the swap is refused. */
export function floorFrom(quote: Quote): bigint {
  return (BigInt(quote.estimate.toAmountMin) * 98n) / 100n;
}

const StatusSchema = z.object({
  status: z.string(),
  substatus: z.string().optional(),
  substatusMessage: z.string().optional(),
  tool: z.string().max(80).optional(),
  toAddress: z.string().optional(),
  sending: z.object({ txHash: z.string().optional() }).optional(),
  receiving: z.object({
    txHash: z.string().optional(), amount: z.string().optional(), chainId: z.number().optional(),
    token: z.object({ address: z.string().optional(), symbol: z.string().max(40).optional(), decimals: z.number().optional() }).optional(),
  }).optional(),
});

export type SwapStatus =
  /** Not known yet, not found yet, or an answer that is not about our transaction. Keep waiting. */
  | { state: "pending"; detail: string }
  | { state: "done"; received: string; tool: string; receivingTxHash?: string | undefined }
  /** The route finished, but something other than the pinned token arrived at the destination. */
  | { state: "other-token"; detail: string }
  | { state: "refunded"; detail: string }
  | { state: "failed"; detail: string };

export interface StatusExpectation {
  txHash: string;
  fromChainId: number;
  toChainId: number;
  toToken: string;
  toAddress: string;
}

/** Pure: LI.FI's status body in, what it means for our swap out. An answer about another transaction is never trusted. */
export function readStatus(body: unknown, expect: StatusExpectation): SwapStatus {
  const parsed = StatusSchema.safeParse(body);
  if (!parsed.success) return { state: "pending", detail: "LI.FI's status answer could not be read." };
  const s = parsed.data;
  if (!sameAddress(s.sending?.txHash, expect.txHash)) return { state: "pending", detail: "LI.FI does not know this transaction yet." };
  const detail = (s.substatusMessage ?? s.substatus ?? s.status).replace(/\s+/g, " ").slice(0, 200);
  if (s.status === "FAILED") return { state: "failed", detail };
  if (s.status !== "DONE") return { state: "pending", detail };
  if (s.substatus === "REFUNDED") return { state: "refunded", detail };
  const r = s.receiving;
  const ours = r !== undefined && r.chainId === expect.toChainId && sameAddress(r.token?.address, expect.toToken) && sameAddress(s.toAddress, expect.toAddress) && /^[0-9]+$/.test(r.amount ?? "");
  if (s.substatus !== "COMPLETED" || !ours) return { state: "other-token", detail: `${detail} LI.FI reports ${r?.amount ?? "an unknown amount"} of ${r?.token?.symbol ?? "another token"} on chain ${r?.chainId ?? "?"}.` };
  return { state: "done", received: r!.amount!, tool: s.tool ?? "unknown", receivingTxHash: r!.txHash };
}

export async function fetchStatus(expect: StatusExpectation, fetchImpl: typeof fetch = fetch): Promise<SwapStatus> {
  try {
    const query = new URLSearchParams({ txHash: expect.txHash, fromChain: String(expect.fromChainId) });
    const response = await fetchImpl(`${LIFI_API}/status?${query.toString()}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
    if (response.status !== 200) return { state: "pending", detail: response.status === 404 ? "LI.FI does not know this transaction yet." : `LI.FI answered ${response.status}.` };
    return readStatus(await response.json(), expect);
  } catch {
    return { state: "pending", detail: "LI.FI could not be reached." };
  }
}
