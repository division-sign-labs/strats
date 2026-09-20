// Carrying out a buyback, one recorded step at a time. Everything that touches
// the venue, the wallet, LI.FI, the clock or the disk comes in through `deps`,
// so the whole sequence, and every way of stopping half way and starting again,
// is tested with fakes. Nothing in this file signs or sends by itself.
//
// The rules that keep a payout from happening twice:
//   - one journal at most, and no new payout while it exists;
//   - the journal is saved with the next stage before the action that makes it true;
//   - a withdrawal whose result is unknown is never sent again: a later run looks for evidence;
//   - a transaction is signed, and its hash and nonce saved, before it is broadcast, and
//     it may only ever be sent again with that same nonce;
//   - the amount swapped is the journal's, never "whatever the wallet holds";
//   - the withdrawal is written to the payout record the moment the money leaves.
import { usd } from "../reconcile.js";
import type { BuybackLine, LedgerLine, WithdrawalLine } from "../payouts.js";
import type { Journal, JournalStore, SentTx } from "./journal.js";
import { floorFrom, type Quote, type SwapStatus } from "./lifi.js";

export const ARRIVAL_POLL_MS = 15_000;
export const ARRIVAL_TIMEOUT_MS = 20 * 60_000;
export const STATUS_POLL_MS = 15_000;
export const STATUS_TIMEOUT_MS = 30 * 60_000;
export const RECEIPT_POLL_MS = 5_000;
export const RECEIPT_TIMEOUT_MS = 5 * 60_000;
/** How long a withdrawal with no trace is still looked for before it is declared never sent. */
export const WITHDRAW_EVIDENCE_MS = 30 * 60_000;
/** A quote older than this is taken again before the swap is signed. */
export const QUOTE_FRESH_MS = 30_000;
/** One cent of a 6-decimal token: the tolerance when checking that the withdrawal arrived. */
const ARRIVAL_TOLERANCE_UNITS = 10_000n;

/** Thrown by the venue when it is certain that no withdrawal went out. Any other error means the result is unknown. */
export class WithdrawNotSentError extends Error {
  /** Hyperliquid dex bots only: the money was moved from the dex to the main account before the withdrawal was refused. It is still on Hyperliquid. */
  readonly movedToMain: boolean;
  constructor(message: string, movedToMain = false) {
    super(message);
    this.movedToMain = movedToMain;
  }
}

export interface VenuePort {
  name: "hyperliquid" | "polymarket";
  /** "Hyperliquid" or "Polymarket". */
  label: string;
  /** Send the withdrawal to the bot's own wallet. Always that address: nothing passed in can change it. */
  withdraw(usdAmount: number): Promise<void>;
  /** Look at the venue's own history for a withdrawal that may have gone out. */
  evidence(journal: Journal): Promise<"withdrawn" | "moved-to-main" | "none">;
}

export interface SignedTx {
  raw: string;
  hash: string;
}

export interface WalletPort {
  address: string;
  chainId: number;
  /** "Arbitrum" or "Polygon". */
  chainName: string;
  /** "USDC" or "pUSD". */
  sourceSymbol: string;
  explorerAddressUrl: string;
  sourceBalance(): Promise<bigint>;
  /** What the pinned LI.FI contract may spend. */
  allowance(): Promise<bigint>;
  /** Transactions of this wallet that are mined. */
  minedNonce(): Promise<number>;
  /** The nonce for a new transaction. */
  nextNonce(): Promise<number>;
  /** Approve exactly `amount` to the pinned LI.FI contract. Signs only. */
  signApprove(amount: bigint, nonce: number): Promise<SignedTx>;
  /** Sign the quote's transaction. Signs only. */
  signSwap(tx: Quote["transactionRequest"], nonce: number): Promise<SignedTx>;
  broadcast(raw: string): Promise<void>;
  receipt(hash: string): Promise<"success" | "reverted" | null>;
}

export type FreshQuote = { ok: true; quote: Quote } | { ok: false; reasons: string[] };

export interface BuybackDeps {
  venue: VenuePort;
  wallet: WalletPort;
  lifi: {
    /** A live quote for exactly `amountUnits`, already checked. With `floorMinOut`, it must also promise at least that much. */
    quote(amountUnits: bigint, floorMinOut?: bigint): Promise<FreshQuote>;
    status(txHash: string): Promise<SwapStatus>;
  };
  clock: { now(): number; sleep(ms: number): Promise<void> };
  journal: JournalStore;
  ledger: { has(type: LedgerLine["type"], id: string): boolean; append(line: LedgerLine): void };
  /** Tell the droplet, if there is one. Prints its own line on failure and never throws. */
  sync(): void;
  print(line: string): void;
  /** Dots while waiting. */
  progress(text: string): void;
  /** "Go ahead?", always asked of a person. There is no way to answer it from a flag. */
  confirm(): Promise<boolean>;
  /** The route and quote lines shown before a resumed run asks again. */
  describeQuote(quote: Quote): string[];
  /** The chain the token is on, by name. */
  tokenChainName: string;
}

export interface PayoutParams {
  id: string;
  dex?: string;
  withdrawUsd: number;
  feeUsd: number;
  arriveUnits: bigint;
  profitSettledUsd: number;
  buybackPct: number;
  token: { chainId: number; address: string };
  destination: string;
  floorMinOut: bigint;
  tokenSymbol: string;
  tokenDecimals: number;
}

/** 0 done or declined, 1 failed before anything moved, 3 stopped part-way with the money safe. "replan" means nothing was sent and the caller plans afresh. */
export type Outcome = { code: 0 | 1 | 3 } | { code: "replan" };

const unitsToUsd = (units: bigint): number => Number(units) / 1e6;
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);

/** Whole token units as a plain number with thousands separators, rounded down to whole tokens when there are many. */
export function tokenAmount(units: bigint | string, decimals: number): string {
  const value = BigInt(units);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  if (whole >= 1000n) return whole.toLocaleString("en-US");
  const fraction = (value % base).toString().padStart(decimals, "0").slice(0, 4).replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

/** Where the money is, said the same way every time. */
export const moneyText = {
  nothingLeft: (deps: Pick<BuybackDeps, "venue">): string => `Nothing left ${deps.venue.label}.`,
  onItsWay: (deps: Pick<BuybackDeps, "wallet">, j: Journal): string =>
    `The withdrawal of ${usd(j.withdrawUsd)} is on its way to your wallet ${deps.wallet.address} on ${deps.wallet.chainName}. Run strats buyback --execute again to continue.`,
  arrived: (deps: Pick<BuybackDeps, "wallet">, j: Journal): string =>
    `${usd(unitsToUsd(BigInt(j.arriveUnits)))} ${deps.wallet.sourceSymbol} is in your wallet ${deps.wallet.address} on ${deps.wallet.chainName}. Nothing was swapped. Run strats buyback --execute again to continue.`,
  inFlight: (hash: string): string => `The swap is in flight (transaction ${hash}). Run strats buyback --execute again to check it.`,
};

/** After the user said yes to a fresh plan: record it, then carry it out. */
export async function startPayout(deps: BuybackDeps, params: PayoutParams): Promise<Outcome> {
  if (deps.journal.load() !== null) throw new Error("A buyback is already in flight.");
  const before = await deps.wallet.sourceBalance();
  const journal: Journal = {
    v: 1, id: params.id, startedAt: new Date(deps.clock.now()).toISOString(), venue: deps.venue.name,
    ...(params.dex !== undefined ? { dex: params.dex } : {}),
    withdrawUsd: params.withdrawUsd, arriveUnits: params.arriveUnits.toString(), profitSettledUsd: params.profitSettledUsd, buybackPct: params.buybackPct,
    feeUsd: params.feeUsd, token: params.token, destination: params.destination, floorMinOut: params.floorMinOut.toString(),
    tokenSymbol: params.tokenSymbol, tokenDecimals: params.tokenDecimals,
    walletBalanceBeforeUnits: before.toString(), stage: "confirmed",
  };
  deps.journal.create(journal);
  return advance(deps, journal, false);
}

/** A journal exists: never start anything new, continue from what it says. */
export async function resumePayout(deps: BuybackDeps, journal: Journal): Promise<Outcome> {
  deps.print(`Continuing the buyback started ${journal.startedAt}.`);
  return advance(deps, journal, true);
}

async function advance(deps: BuybackDeps, start: Journal, resumed: boolean): Promise<Outcome> {
  let j = start;
  const amount = BigInt(j.arriveUnits);
  /** A resumed run shows the new quote and asks again before it approves or swaps. */
  let mustAsk = resumed;
  let held: { quote: Quote; at: number } | undefined;
  const save = (next: Journal): Journal => {
    deps.journal.save(next);
    j = next;
    return next;
  };

  const recordWithdrawal = (): void => {
    const line: WithdrawalLine = {
      v: 1, type: "withdrawal", id: j.id, at: j.withdrawSentAt ?? new Date(deps.clock.now()).toISOString(), venue: j.venue,
      usd: j.withdrawUsd, feeUsd: j.feeUsd, profitSettledUsd: j.profitSettledUsd, buybackPct: j.buybackPct,
    };
    // The record refuses a second line for the same payout, so this is safe to repeat after a stop.
    if (!deps.ledger.has("withdrawal", j.id)) {
      deps.ledger.append(line);
      deps.sync();
    }
  };
  const withdrawalConfirmed = (): void => {
    save({ ...j, stage: "withdraw_sent", withdrawSentAt: j.withdrawSentAt ?? new Date(deps.clock.now()).toISOString() });
    recordWithdrawal();
  };
  const arrivedInWallet = async (): Promise<boolean> => (await deps.wallet.sourceBalance()) - BigInt(j.walletBalanceBeforeUnits) >= amount - ARRIVAL_TOLERANCE_UNITS;

  /** The swap spends the journal's amount, so the wallet must hold it. Checked before anything is quoted, approved or signed. */
  const moneyMissing = async (): Promise<Outcome | null> => {
    let balance: bigint;
    try {
      balance = await deps.wallet.sourceBalance();
    } catch (error) {
      deps.print(`The wallet's balance could not be read (${message(error)}). Nothing was signed. Run strats buyback --execute again.`);
      return { code: 3 };
    }
    if (balance >= amount - ARRIVAL_TOLERANCE_UNITS) return null;
    deps.print(`The wallet ${deps.wallet.address} holds ${usd(unitsToUsd(balance))} ${deps.wallet.sourceSymbol}, less than the ${usd(unitsToUsd(amount))} this buyback swaps. Nothing was signed. Put the money back in the wallet, then run strats buyback --execute again.`);
    return { code: 3 };
  };

  /** A fresh, checked quote; shown and confirmed again when the run was resumed. Null means stop, with the code to stop with. */
  const freshQuote = async (): Promise<Quote | Outcome> => {
    if (held && !mustAsk && deps.clock.now() - held.at < QUOTE_FRESH_MS) return held.quote;
    const result = await deps.lifi.quote(amount, mustAsk ? undefined : BigInt(j.floorMinOut));
    if (!result.ok) {
      deps.print(`The swap was not sent: ${result.reasons.join("; ")}.`);
      deps.print(moneyText.arrived(deps, j));
      return { code: 3 };
    }
    if (mustAsk) {
      for (const line of deps.describeQuote(result.quote)) deps.print(line);
      if (!(await deps.confirm())) {
        deps.print("Nothing was changed.");
        deps.print(moneyText.arrived(deps, j));
        return { code: 0 };
      }
      // The user saw this quote, so the floor is measured from it.
      save({ ...j, floorMinOut: floorFrom(result.quote).toString(), tokenSymbol: result.quote.action.toToken.symbol, tokenDecimals: result.quote.action.toToken.decimals });
      mustAsk = false;
    }
    held = { quote: result.quote, at: deps.clock.now() };
    return result.quote;
  };

  const waitForReceipt = async (hashes: string[]): Promise<{ hash: string; result: "success" | "reverted" } | null> => {
    const deadline = deps.clock.now() + RECEIPT_TIMEOUT_MS;
    for (;;) {
      const found = await findReceipt(deps, hashes);
      if (found) return found;
      if (deps.clock.now() >= deadline) return null;
      await deps.clock.sleep(RECEIPT_POLL_MS);
    }
  };
  const allHashes = (tx: SentTx): string[] => [tx.hash, ...(tx.earlier ?? [])];
  const anotherTransaction = (): Outcome => {
    deps.print(`Another transaction used this wallet. Check ${deps.wallet.explorerAddressUrl} before running again.`);
    return { code: 3 };
  };
  /** Back to "the money is in the wallet": a transaction that was mined and failed is final, and its nonce is spent. */
  const backToArrived = (note: string): Outcome => {
    const { approve: _approve, swap: _swap, ...rest } = j;
    save({ ...rest, stage: "arrived", note });
    deps.print(note);
    deps.print(moneyText.arrived(deps, j));
    return { code: 3 };
  };

  for (;;) {
    switch (j.stage) {
      case "confirmed": {
        if (resumed) {
          // Saved, but the step after it never began: nothing was sent.
          deps.journal.remove();
          deps.print("That buyback was confirmed but nothing was sent. Planning it again.");
          return { code: "replan" };
        }
        save({ ...j, stage: "withdraw_sending" });
        try {
          await deps.venue.withdraw(j.withdrawUsd);
        } catch (error) {
          if (error instanceof WithdrawNotSentError) {
            deps.journal.remove();
            deps.print(`The withdrawal was not sent: ${message(error)}`);
            // The last line says where the money is: strats status shows it.
            if (error.movedToMain) deps.print(`${usd(j.withdrawUsd)} was moved from the "${j.dex ?? ""}" dex to your main Hyperliquid account and is still there. ${moneyText.nothingLeft(deps)} To move it back to the dex: strats fund`);
            else deps.print(moneyText.nothingLeft(deps));
            return { code: error.movedToMain ? 3 : 1 };
          }
          deps.print(`The withdrawal may or may not have gone out (${message(error)}). It is not sent again.`);
          deps.print("Run strats buyback --execute again in a few minutes: it checks what happened before doing anything else.");
          return { code: 3 };
        }
        withdrawalConfirmed();
        deps.print("Withdrawal sent.");
        break;
      }

      case "withdraw_sending": {
        // The result of the withdrawal is unknown. Never send it again: look for it.
        // Money in the wallet is not proof: a deposit lands in the same wallet. Hyperliquid's own history decides. Polymarket has
        // none, so only an increase of exactly the amount counts.
        const delta = (await deps.wallet.sourceBalance()) - BigInt(j.walletBalanceBeforeUnits);
        const evidence = await deps.venue.evidence(j);
        const exact = delta >= amount - ARRIVAL_TOLERANCE_UNITS && delta <= amount + ARRIVAL_TOLERANCE_UNITS;
        const seen = j.venue === "hyperliquid" ? evidence : exact ? "withdrawn" : evidence;
        if (seen === "withdrawn") {
          withdrawalConfirmed();
          deps.print("The withdrawal did go out.");
          break;
        }
        const unexplained = j.venue === "hyperliquid" ? delta >= amount - ARRIVAL_TOLERANCE_UNITS : delta > amount + ARRIVAL_TOLERANCE_UNITS;
        if (unexplained) {
          deps.print(`Your wallet received ${usd(unitsToUsd(delta))} ${deps.wallet.sourceSymbol} since this buyback started, but ${deps.venue.label} shows no withdrawal of ${usd(j.withdrawUsd)}. It is treated as a deposit: nothing is recorded or swapped. Move it on (strats fund) and run again.`);
          return { code: 3 };
        }
        if (deps.clock.now() - Date.parse(j.startedAt) < WITHDRAW_EVIDENCE_MS) {
          deps.print("Still checking whether the withdrawal went out. Run it again in a few minutes.");
          return { code: 3 };
        }
        deps.journal.remove();
        if (seen === "moved-to-main") {
          deps.print(`The withdrawal never happened, but ${usd(j.withdrawUsd)} was moved from the "${j.dex ?? ""}" dex to your main Hyperliquid account and is still there. ${moneyText.nothingLeft(deps)} To move it back to the dex: strats fund`);
          return { code: 3 };
        }
        deps.print("The withdrawal never happened. Nothing moved.");
        return { code: 1 };
      }

      case "withdraw_sent": {
        recordWithdrawal();
        deps.progress(`Waiting for the ${deps.wallet.sourceSymbol} to arrive`);
        const deadline = deps.clock.now() + ARRIVAL_TIMEOUT_MS;
        let arrived = await arrivedInWallet();
        while (!arrived && deps.clock.now() < deadline) {
          deps.progress(".");
          await deps.clock.sleep(ARRIVAL_POLL_MS);
          arrived = await arrivedInWallet().catch(() => false);
        }
        deps.progress("\n");
        if (!arrived) {
          deps.print(moneyText.onItsWay(deps, j));
          return { code: 3 };
        }
        save({ ...j, stage: "arrived" });
        break;
      }

      case "arrived": {
        recordWithdrawal();
        const missing = await moneyMissing();
        if (missing) return missing;
        const quote = await freshQuote();
        if ("code" in quote) return quote;
        // An approval left over from a stopped run is reused. Otherwise approve exactly this payout, never more.
        if ((await deps.wallet.allowance()) >= amount) {
          save({ ...j, stage: "approved" });
          break;
        }
        let signed: SignedTx;
        let nonce: number;
        try {
          nonce = await deps.wallet.nextNonce();
          signed = await deps.wallet.signApprove(amount, nonce);
        } catch (error) {
          deps.print(`The approval was not sent: ${message(error)}`);
          deps.print(moneyText.arrived(deps, j));
          return { code: 3 };
        }
        save({ ...j, stage: "approve_sending", approve: { nonce, hash: signed.hash } });
        const sent = await sendAndWait(deps, signed, waitForReceipt, [signed.hash]);
        if (sent === "unconfirmed") {
          deps.print(`The approval (transaction ${signed.hash}) is not confirmed yet.`);
          deps.print(moneyText.arrived(deps, j));
          return { code: 3 };
        }
        if (sent === "reverted") return backToArrived(`The approval failed on ${deps.wallet.chainName} (transaction ${signed.hash}).`);
        save({ ...j, stage: "approved" });
        deps.print("Approved.");
        break;
      }

      case "approve_sending": {
        const tx = j.approve;
        if (!tx) return backToArrived("The record of the approval is incomplete.");
        if ((await deps.wallet.allowance()) >= amount) {
          save({ ...j, stage: "approved" });
          break;
        }
        const found = await findReceipt(deps, allHashes(tx));
        if (found?.result === "reverted") return backToArrived(`The approval failed on ${deps.wallet.chainName} (transaction ${found.hash}).`);
        if (found?.result === "success") {
          save({ ...j, stage: "approved" });
          deps.print("Approved.");
          break;
        }
        // Not found. It may only ever go out again with the nonce it was signed with.
        if ((await deps.wallet.minedNonce()) > tx.nonce) return anotherTransaction();
        const quote = await freshQuote();
        if ("code" in quote) return quote;
        let signed: SignedTx;
        try {
          signed = await deps.wallet.signApprove(amount, tx.nonce);
        } catch (error) {
          deps.print(`The approval was not sent: ${message(error)}`);
          deps.print(moneyText.arrived(deps, j));
          return { code: 3 };
        }
        const hashes = [...new Set([signed.hash, ...allHashes(tx)])];
        save({ ...j, approve: { nonce: tx.nonce, hash: signed.hash, earlier: hashes.slice(1) } });
        const sent = await sendAndWait(deps, signed, waitForReceipt, hashes);
        if (sent === "unconfirmed") {
          deps.print(`The approval (transaction ${signed.hash}) is not confirmed yet.`);
          deps.print(moneyText.arrived(deps, j));
          return { code: 3 };
        }
        if (sent === "reverted") return backToArrived(`The approval failed on ${deps.wallet.chainName} (transaction ${signed.hash}).`);
        save({ ...j, stage: "approved" });
        deps.print("Approved.");
        break;
      }

      case "approved": {
        const missing = await moneyMissing();
        if (missing) return missing;
        const quote = await freshQuote();
        if ("code" in quote) return quote;
        const outcome = await signAndSendSwap(quote, undefined);
        if (outcome) return outcome;
        break;
      }

      case "swap_sending": {
        const tx = j.swap;
        if (!tx) return backToArrived("The record of the swap is incomplete.");
        const found = await findReceipt(deps, allHashes(tx));
        if (found?.result === "reverted") return backToArrived(`The swap transaction failed on ${deps.wallet.chainName} (transaction ${found.hash}).`);
        if (found?.result === "success") {
          // LI.FI is asked about the transaction that was actually mined.
          save({ ...j, stage: "swap_sent", swap: { ...tx, hash: found.hash } });
          break;
        }
        if ((await deps.wallet.minedNonce()) > tx.nonce) return anotherTransaction();
        // Never seen by the chain, and its nonce is still free: quote again and sign with that same nonce.
        const quote = await freshQuote();
        if ("code" in quote) return quote;
        const outcome = await signAndSendSwap(quote, tx);
        if (outcome) return outcome;
        break;
      }

      case "swap_sent": {
        const tx = j.swap;
        if (!tx) return backToArrived("The record of the swap is incomplete.");
        const deadline = deps.clock.now() + STATUS_TIMEOUT_MS;
        let status = await deps.lifi.status(tx.hash);
        while (status.state === "pending" && deps.clock.now() < deadline) {
          deps.progress(".");
          await deps.clock.sleep(STATUS_POLL_MS);
          status = await deps.lifi.status(tx.hash);
        }
        deps.progress("\n");
        if (status.state === "pending") {
          deps.print(moneyText.inFlight(tx.hash));
          return { code: 3 };
        }
        const spentUsd = unitsToUsd(amount);
        if (status.state === "done") {
          const line: BuybackLine = {
            v: 1, type: "buyback", id: j.id, at: new Date(deps.clock.now()).toISOString(), spentUsd, fromChainId: deps.wallet.chainId,
            token: j.token, destination: j.destination, received: status.received, decimals: j.tokenDecimals, txHash: tx.hash, tool: status.tool || tx.tool || "unknown",
          };
          if (!deps.ledger.has("buyback", j.id)) deps.ledger.append(line);
          deps.journal.remove();
          deps.sync();
          deps.print(`Bought ${tokenAmount(status.received, j.tokenDecimals)} ${j.tokenSymbol} for ${usd(spentUsd)}. They are at ${j.destination} on ${deps.tokenChainName}.`);
          return { code: 0 };
        }
        if (status.state === "other-token") {
          // Final, and not a purchase of the token: close the payout without counting a buyback.
          deps.journal.remove();
          deps.print(`The route finished without buying ${j.tokenSymbol}. ${status.detail}`);
          deps.print(`What arrived is at ${j.destination}. This buyback is closed and no purchase is recorded. The withdrawal of ${usd(j.withdrawUsd)} stays counted, so it is not paid again.`);
          return { code: 3 };
        }
        // Failed or refunded. When the money is back in the wallet, the next run can quote and swap again.
        const what = `LI.FI reports that the swap ${status.state === "refunded" ? "was refunded" : "failed"}: ${status.detail}`;
        if (await arrivedInWallet().catch(() => false)) return backToArrived(`${what} The ${deps.wallet.sourceSymbol} is back in your wallet.`);
        save({ ...j, note: what.slice(0, 400) });
        deps.print(what);
        deps.print(`Any refund goes to your wallet ${deps.wallet.address} on ${deps.wallet.chainName}. Run strats buyback --execute again once it has arrived.`);
        return { code: 3 };
      }
    }
  }

  /** Sign with a new nonce, or with `again`'s nonce when a swap that never reached the chain is replaced. Returns an outcome to stop with, or nothing to continue. */
  async function signAndSendSwap(quote: Quote, again: NonNullable<Journal["swap"]> | undefined): Promise<Outcome | undefined> {
    let signed: SignedTx;
    let nonce: number;
    try {
      nonce = again ? again.nonce : await deps.wallet.nextNonce();
      signed = await deps.wallet.signSwap(quote.transactionRequest, nonce);
    } catch (error) {
      deps.print(`The swap was not sent: ${message(error)}`);
      deps.print(moneyText.arrived(deps, j));
      return { code: 3 };
    }
    const hashes = [...new Set([signed.hash, ...(again ? [again.hash, ...(again.earlier ?? [])] : [])])];
    save({ ...j, stage: "swap_sending", swap: { nonce, hash: signed.hash, ...(hashes.length > 1 ? { earlier: hashes.slice(1) } : {}), quoteMinOut: quote.estimate.toAmountMin, tool: quote.tool } });
    const sent = await sendAndWait(deps, signed, waitForReceipt, hashes, () => deps.print(`Swap sent: ${signed.hash}`));
    if (sent === "unconfirmed") {
      deps.print(moneyText.inFlight(signed.hash));
      return { code: 3 };
    }
    if (sent === "reverted") return backToArrived(`The swap transaction failed on ${deps.wallet.chainName} (transaction ${signed.hash}).`);
    const mined = j.swap!;
    save({ ...j, stage: "swap_sent", swap: { ...mined, hash: sent } });
    return undefined;
  }
}

async function findReceipt(deps: BuybackDeps, hashes: string[]): Promise<{ hash: string; result: "success" | "reverted" } | null> {
  for (const hash of hashes) {
    const result = await deps.wallet.receipt(hash).catch(() => null);
    if (result) return { hash, result };
  }
  return null;
}

/** Broadcast, then wait for whichever of `hashes` is mined. Returns the mined hash on success. A failed broadcast is not proof that nothing was sent, so the wait still runs. */
async function sendAndWait(
  deps: BuybackDeps, signed: SignedTx,
  wait: (hashes: string[]) => Promise<{ hash: string; result: "success" | "reverted" } | null>, hashes: string[], onBroadcast?: () => void,
): Promise<string | "reverted" | "unconfirmed"> {
  let broadcastProblem = "";
  try {
    await deps.wallet.broadcast(signed.raw);
  } catch (error) {
    broadcastProblem = message(error);
  }
  if (broadcastProblem) {
    // One look, not a five-minute wait: most broadcast errors mean the node refused it.
    const found = await findReceipt(deps, hashes);
    if (!found) {
      deps.print(`The node did not accept the transaction (${broadcastProblem}). It may still have been sent.`);
      return "unconfirmed";
    }
    return found.result === "success" ? found.hash : "reverted";
  }
  onBroadcast?.();
  const found = await wait(hashes);
  if (!found) return "unconfirmed";
  return found.result === "success" ? found.hash : "reverted";
}
