// Everything strats buyback says about a plan, as pure functions of the plan
// and the quote, so the exact words are tested. Amounts of money use usd().
import { usd } from "../reconcile.js";
import { sendsMasterKey, type BotState } from "../state.js";
import { LIFI_DIAMOND, calldataNote, priceImpactPct, type Quote } from "./lifi.js";
import { tokenAmount } from "./machine.js";
import { MIN_USD_DEFAULT, type Plan } from "./plan.js";

const CHAIN_LABELS: Readonly<Record<number, string>> = { 1: "Ethereum", 10: "Optimism", 137: "Polygon", 8453: "Base", 42161: "Arbitrum" };
export const chainLabel = (chainId: number): string => CHAIN_LABELS[chainId] ?? `chain ${chainId}`;
/** Tokens on these chains can be bought. */
export const SUPPORTED_TOKEN_CHAINS = [1, 8453, 42161] as const;

export interface RouteContext {
  botId: string;
  venueLabel: "Hyperliquid" | "Polymarket";
  /** "USDC" or "pUSD". */
  sourceSymbol: string;
  /** "Arbitrum" or "Polygon". */
  sourceChain: string;
  sourceChainId: number;
  /** "ETH" or "POL". */
  nativeSymbol: string;
  walletAddress: string;
  token: { chainId: number; address: string };
  destination: string;
  /** True when the destination is the bot's own wallet. */
  destinationIsWallet: boolean;
  split: { buybackPct: number; keepPct: number };
  /** Withdrawals already in the payout record. */
  earlierBuybacks: number;
  slippagePct: number;
  maxImpactPct: number;
}

export interface GasView {
  /** The wallet's gas coin, in whole coins. */
  heldText: string;
  enough: boolean;
  /** What to send first, in whole coins, when there is not enough. */
  shortfallText: string;
}

const LABEL_WIDTH = 24;
const line = (label: string, value: string): string => `  ${label.length >= LABEL_WIDTH ? `${label}  ` : label.padEnd(LABEL_WIDTH)}${value}`;
const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;
const money = (value: string | number | undefined): number => (value === undefined ? 0 : Number(value) || 0);
const percent = (value: number): string => `${Number(value.toFixed(2))}%`;
/** A 6-decimal amount in whole cents, without the dollar sign: it counts tokens, not dollars. */
const plain = (value: number): string => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function renderHeader(botId: string, dryRun: boolean): string[] {
  return [`Buyback for bot "${botId}".${dryRun ? " Dry run: nothing is signed or sent." : ""}`, ""];
}

/** Always shown, and first: the deposits figure is what profit is measured from, so it is never hidden. */
export function renderProfit(plan: Plan, ctx: Pick<RouteContext, "venueLabel" | "earlierBuybacks">): string[] {
  const n = ctx.earlierBuybacks;
  return [
    "Profit",
    line("Wallet value now", `${usd(plan.equityUsd)} on ${ctx.venueLabel}`),
    line("Deposits less withdrawals", usd(plan.basisUsd)),
    line("Profit so far", usd(plan.profitUsd)),
    line("Already split", n === 0 ? `${usd(plan.settledUsd)}, no earlier buybacks` : `${usd(plan.settledUsd)} in ${n} earlier buyback${n === 1 ? "" : "s"}`),
    line("Profit to split now", usd(plan.distributableUsd)),
    "",
  ];
}

export function renderSplit(plan: Plan, ctx: Pick<RouteContext, "venueLabel" | "split">): string[] {
  const where = ctx.venueLabel === "Hyperliquid" ? "stays in the Hyperliquid account" : "stays in the Polymarket deposit wallet";
  const lines = [
    "Split, pinned on this machine",
    line(`${ctx.split.buybackPct}% buys the token`, usd(plan.wantUsd)),
    line(`${ctx.split.keepPct}% is kept`, `${usd(Math.max(0, plan.distributableUsd - plan.wantUsd))} ${where}`),
  ];
  if (plan.clamped) lines.push(`  Only ${usd(plan.freeUsd)} is free; the rest is in open positions. This buyback uses ${usd(plan.withdrawUsd)}.`);
  return [...lines, ""];
}

function duration(seconds: number): string {
  if (!(seconds > 0)) return "";
  return seconds >= 120 ? ` About ${Math.round(seconds / 60)} minutes.` : ` About ${Math.max(1, Math.round(seconds))} seconds.`;
}

/** The tools that move the money, without LI.FI's own fee step. */
export function routeTools(quote: Quote): string {
  const tools = quote.includedSteps.filter((step) => step.type !== "protocol" && step.tool).map((step) => step.tool);
  return tools.length > 0 ? tools.join(" + ") : quote.tool;
}

const destinationNote = (ctx: Pick<RouteContext, "destinationIsWallet">): string => (ctx.destinationIsWallet ? "this bot's own wallet" : "the address you pinned");

/** `withWithdrawal` is false for a resumed run whose withdrawal already arrived. */
export function renderRoute(plan: Pick<Plan, "withdrawUsd" | "feeUsd" | "arriveUsd">, quote: Quote, ctx: RouteContext, withWithdrawal = true): string[] {
  const amount = `${plain(plan.arriveUsd)} ${ctx.sourceSymbol}`;
  const diamond = LIFI_DIAMOND[ctx.sourceChainId] ?? "";
  const symbol = quote.action.toToken.symbol;
  const withdrawal = ctx.venueLabel === "Hyperliquid"
    ? `Withdraw ${usd(plan.withdrawUsd)} USDC from Hyperliquid to your wallet ${ctx.walletAddress} on ${ctx.sourceChain}. Hyperliquid keeps ${usd(plan.feeUsd)}, so ${usd(plan.arriveUsd)} arrives. About 5 minutes.`
    : `Withdraw ${usd(plan.withdrawUsd)} pUSD from the Polymarket deposit wallet to your wallet ${ctx.walletAddress} on ${ctx.sourceChain}. No fee.`;
  const steps = [
    ...(withWithdrawal ? [withdrawal] : []),
    `Approve exactly ${amount} to LI.FI (${shortAddress(diamond)}) on ${ctx.sourceChain}.`,
    `Swap ${amount} on ${ctx.sourceChain} for ${symbol} (${ctx.token.address}) on ${chainLabel(ctx.token.chainId)}, through LI.FI (${routeTools(quote)}).${duration(quote.estimate.executionDuration)}`,
  ];
  return [
    "Route",
    ...steps.map((step, index) => `  ${index + 1}. ${step}`),
    line("Tokens go to", `${ctx.destination} on ${chainLabel(ctx.token.chainId)} (${destinationNote(ctx)})`),
    "",
  ];
}

function feeParts(plan: Pick<Plan, "feeUsd">, quote: Quote, ctx: Pick<RouteContext, "venueLabel">, venueWord: string): string[] {
  return [
    ...(plan.feeUsd > 0 ? [`${ctx.venueLabel}${venueWord} ${usd(plan.feeUsd)}`] : []),
    ...quote.estimate.feeCosts.map((fee) => `${fee.name} ${usd(money(fee.amountUSD))}`),
  ];
}

const gasUsd = (quote: Quote): number => quote.estimate.gasCosts.reduce((sum, gas) => sum + money(gas.amountUSD), 0);

export function renderQuote(plan: Pick<Plan, "feeUsd">, quote: Quote, ctx: RouteContext, gas: GasView | null, at: Date): string[] {
  const { toToken } = quote.action;
  const impact = priceImpactPct(quote);
  const time = at.toTimeString().slice(0, 8);
  // Said plainly whenever the recipient or the minimum is LI.FI's word and not in the transaction that is signed.
  const note = calldataNote(quote);
  return [
    `Quote, live at ${time}`,
    line("You receive about", `${tokenAmount(quote.estimate.toAmount, toToken.decimals)} ${toToken.symbol} (${usd(money(quote.estimate.toAmountUSD))})`),
    line("You receive at least", `${tokenAmount(quote.estimate.toAmountMin, toToken.decimals)} ${toToken.symbol} with ${percent(ctx.slippagePct)} slippage allowed`),
    line("Price impact", `${Number.isFinite(impact) ? `${Math.max(0, impact).toFixed(1)}%` : "unknown"} (limit ${percent(ctx.maxImpactPct)})`),
    line("Fees", [...feeParts(plan, quote, ctx, " withdrawal"), `gas about ${usd(gasUsd(quote))} in ${ctx.nativeSymbol} on ${ctx.sourceChain}`].join("; ")),
    ...(gas ? [line("Gas", gas.enough
      ? `the wallet holds ${gas.heldText} ${ctx.nativeSymbol} on ${ctx.sourceChain}, enough`
      : `the wallet holds ${gas.heldText} ${ctx.nativeSymbol} on ${ctx.sourceChain}, not enough: send about ${gas.shortfallText} ${ctx.nativeSymbol} on ${ctx.sourceChain} to ${ctx.walletAddress} first`)] : []),
    ...(note ? [line("Not checked", note)] : []),
    "",
  ];
}

/** The block above the question. `floorMinOut` is the least a later quote may promise. `withWithdrawal` is false once the withdrawal has arrived. */
export function renderConfirmation(plan: Pick<Plan, "withdrawUsd" | "feeUsd" | "arriveUsd">, quote: Quote, ctx: RouteContext, floorMinOut: bigint, withWithdrawal = true): string[] {
  const { toToken } = quote.action;
  const rows: Array<[string, string]> = [
    ...(withWithdrawal ? [["Withdraw", ctx.venueLabel === "Hyperliquid"
      ? `${usd(plan.withdrawUsd)} USDC from Hyperliquid (fee ${usd(plan.feeUsd)})`
      : `${usd(plan.withdrawUsd)} pUSD from the Polymarket deposit wallet (no fee)`] as [string, string]] : []),
    ["Swap", `${plain(plan.arriveUsd)} ${ctx.sourceSymbol} on ${ctx.sourceChain} for ${toToken.symbol} ${ctx.token.address} on ${chainLabel(ctx.token.chainId)} (chain ${ctx.token.chainId})`],
    ["Send to", `${ctx.destination} (${destinationNote(ctx)})`],
    ["At least", withWithdrawal
      ? `${tokenAmount(floorMinOut, toToken.decimals)} ${toToken.symbol}. The price is checked again after the withdrawal arrives; if it promises less, the swap is not sent and the ${ctx.sourceSymbol} stays in your wallet.`
      : `${tokenAmount(floorMinOut, toToken.decimals)} ${toToken.symbol}. The price is checked again just before the swap is signed; if it promises less, the swap is not sent and the ${ctx.sourceSymbol} stays in your wallet.`],
    ["Fees", [...(withWithdrawal ? feeParts(plan, quote, ctx, "") : feeParts({ feeUsd: 0 }, quote, ctx, "")), `gas about ${usd(gasUsd(quote))}`].join("; ")],
  ];
  const note = calldataNote(quote);
  if (note) rows.push(["Not checked", note]);
  return ["This moves real money.", ...rows.map(([label, value]) => `  ${label.padEnd(12)}${value}`)];
}

export const CONFIRM_QUESTION = "Go ahead? (y/N)";
export const DRY_RUN_FOOTER = "Nothing was sent. To carry it out: strats buyback --execute";

/**
 * The one question behind auto-buyback, asked by strats init and restated by strats config auto-buyback on. A Hyperliquid bot gives up
 * "the droplet cannot withdraw". A theme or team bot's droplet already holds its wallet key, so the question says that instead.
 */
export function autoBuybackQuestion(bot: Pick<BotState, "strategyId">): string {
  return sendsMasterKey({ ...bot, autoBuyback: true })
    ? "Buy back automatically? This puts your wallet key on your droplet, so the droplet can withdraw."
    : "Buy back automatically? Your droplet already holds this bot's wallet key, so nothing more is sent to it.";
}

/** Why a theme or team bot is never offered auto-buyback. Polymarket has no deposit history, so a droplet cannot tell a deposit from profit. */
export const AUTO_BUYBACK_UNAVAILABLE = "Auto-buyback is not offered for this bot: Polymarket shows no deposit history, so money you add could be paid out as profit with nobody asked. Buybacks are yours to run, with strats buyback --execute.";

export function describeAutoBuyback(bot: Pick<BotState, "autoBuyback" | "deployment">): string {
  const setting = bot.autoBuyback === true
    ? `on: once a day the droplet checks the profit and buys back by itself when the buyback share is at least $${MIN_USD_DEFAULT}`
    : "off: nothing is paid out until you run strats buyback --execute";
  if (!bot.deployment || (bot.deployment.autoBuyback === true) === (bot.autoBuyback === true)) return setting;
  return `${setting}. The droplet still has it ${bot.deployment.autoBuyback === true ? "on" : "off"}, until the next: strats deploy`;
}
