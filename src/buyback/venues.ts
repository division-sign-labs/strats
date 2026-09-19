// The venue side of a buyback: what the account is worth, what was deposited,
// what is free to withdraw, and the withdrawal itself. The withdrawal always
// goes to the bot's own wallet address, read from the bot file. No flag, no
// document from Quotient and no quote can change where it goes.
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { KeyRoles } from "@quotient-forecasting/cassie-core";
import { privateKeyToAccount } from "viem/accounts";
import { depositsLessWithdrawals, type PayoutSummary } from "../payouts.js";
import { loadRuntimeState } from "../runtime-state.js";
import { loadPolymarketCreds, type KeystoreSession } from "../session.js";
import { makeSetupContext, readSecret, type Prompts } from "../setup.js";
import { buildAdapter } from "../venue.js";
import { PolymarketVenue, buildPolymarketAdapter } from "../venue-polymarket.js";
import type { Journal } from "./journal.js";
import { WithdrawNotSentError, type VenuePort } from "./machine.js";

/** Said instead of a plan, with exit code 1. */
export class BuybackRefusal extends Error {}

export interface VenueFigures {
  equityUsd: number;
  /** Deposits less withdrawals. */
  basisUsd: number;
  /** Collateral that can be withdrawn now. */
  freeUsd: number;
}

export interface BuybackVenuePort extends VenuePort {
  figures(payouts: PayoutSummary): Promise<VenueFigures>;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
/** The venue answered and refused: nothing was applied. A timeout or a dropped connection is not this. */
const venueRefused = (error: unknown): boolean => error instanceof Error && error.name === "ApiRequestError";
const near = (value: unknown, target: number, below = 0): boolean => {
  const n = Number(value);
  return Number.isFinite(n) && n <= target + 0.005 && n >= target - below - 0.005;
};

export function hyperliquidVenue(session: KeystoreSession, dex: string, prompts: Prompts): BuybackVenuePort {
  const { bot } = session;
  const acct = { venue: "hyperliquid" as const, masterAddress: bot.masterAddress, ...(bot.agentAddress ? { agentAddress: bot.agentAddress } : {}) };
  const user = bot.masterAddress as `0x${string}`;

  return {
    name: "hyperliquid",
    label: "Hyperliquid",

    async figures() {
      const adapter = buildAdapter(dex);
      // The same two numbers the report sends: the dex's account value, and what it can withdraw.
      const [balances, flows] = await Promise.all([adapter.balances(acct), adapter.perpCashFlows(acct, Date.parse(bot.createdAt))]);
      if (!flows.complete) throw new BuybackRefusal("The deposit history could not be read in full, so profit cannot be measured. Try again.");
      // Hyperliquid's own history already counts a withdrawal as money out, so nothing is subtracted here.
      return { equityUsd: balances[0]?.total ?? 0, freeUsd: balances[0]?.available ?? 0, basisUsd: flows.flows.reduce((sum, flow) => sum + flow.amount, 0) };
    },

    async withdraw(usdAmount) {
      const amount = Number(usdAmount.toFixed(2));
      const adapter = buildAdapter(dex);
      if (!adapter.withdraw) throw new WithdrawNotSentError("This version of the Hyperliquid adapter cannot withdraw.");
      let moved = false;
      if (dex !== "") {
        // A HIP-3 dex holds its own collateral, and a withdrawal leaves from the main account: move it there first.
        const masterPk = readSecret(session.keystore, bot.id, KeyRoles.master, session.passphrase);
        if (!masterPk) throw new WithdrawNotSentError("The keystore has no wallet key.");
        const transport = new HttpTransport();
        const info = new InfoClient({ transport });
        let token: string;
        try {
          const usdc = (await info.spotMeta()).tokens.filter((t) => t.index === 0);
          if (usdc.length !== 1 || usdc[0]!.name !== "USDC" || !/^0x[0-9a-fA-F]{32}$/.test(usdc[0]!.tokenId)) throw new Error("Hyperliquid's USDC token could not be confirmed.");
          token = `USDC:${usdc[0]!.tokenId}`;
        } catch (error) {
          throw new WithdrawNotSentError(message(error));
        }
        try {
          await new ExchangeClient({ transport, wallet: privateKeyToAccount(masterPk as `0x${string}`) })
            .sendAsset({ destination: user, sourceDex: dex, destinationDex: "", token, amount: amount.toFixed(2), fromSubAccount: "" });
        } catch (error) {
          if (venueRefused(error)) throw new WithdrawNotSentError(message(error));
          throw error;
        }
        moved = true;
        // The main account shows the money within a moment. Withdrawing before it does would be refused.
        for (let attempt = 0; attempt < 15; attempt++) {
          const main = await info.clearinghouseState({ user }).catch(() => null);
          if (main && Number(main.withdrawable) + 0.005 >= amount) break;
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
      try {
        await adapter.withdraw(makeSetupContext(bot.id, session.keystore, session.passphrase, prompts), acct, { to: bot.masterAddress, amount });
      } catch (error) {
        // These are raised before anything is signed, or are the venue's own refusal.
        if (venueRefused(error) || /^(nothing to withdraw|insufficient withdrawable balance|master key missing)/.test(message(error))) throw new WithdrawNotSentError(message(error), moved);
        throw error;
      }
    },

    async evidence(journal: Journal) {
      const rows = await new InfoClient({ transport: new HttpTransport() }).userNonFundingLedgerUpdates({ user, startTime: Math.max(0, Date.parse(journal.startedAt) - 60_000) });
      const w = journal.withdrawUsd;
      // Whether Hyperliquid records the amount asked for or the amount after its fee is not settled by its documentation, so either counts.
      const withdrawn = rows.some((row) => row.delta.type === "withdraw" && near(row.delta.usdc, w, journal.feeUsd));
      if (withdrawn) return "withdrawn";
      const moved = (journal.dex ?? "") !== "" && rows.some((row) => {
        const d = row.delta;
        return d.type === "send" && d.user.toLowerCase() === user.toLowerCase() && d.sourceDex === journal.dex && d.destinationDex === "" && near(d.amount, w);
      });
      return moved ? "moved-to-main" : "none";
    },
  };
}

export function polymarketVenue(session: KeystoreSession, prompts: Prompts): BuybackVenuePort {
  const { bot } = session;
  if (!bot.polymarket) throw new BuybackRefusal("This bot has no Polymarket account yet. Run: strats init");
  const account = bot.polymarket;
  const acct = { venue: "polymarket" as const, ...account };

  return {
    name: "polymarket",
    label: "Polymarket",

    async figures(payouts) {
      const state = loadRuntimeState(bot.id);
      if (state.netDepositsUsd === undefined) {
        throw new BuybackRefusal("This machine has no record of what was deposited. Run strats fund here, or: strats buyback --set-deposits <usd>");
      }
      // Free collateral plus the positions Polymarket lists. A position it does not list is left out, which can only lower the payout.
      const snap = await new PolymarketVenue(account, loadPolymarketCreds(session), { readOnly: true }).snapshot([], []);
      return { equityUsd: snap.equityUsd, freeUsd: snap.collateralUsd, basisUsd: depositsLessWithdrawals(state.netDepositsUsd, state.netDepositsAt, payouts.withdrawals) };
    },

    async withdraw(usdAmount) {
      const adapter = buildPolymarketAdapter(loadPolymarketCreds(session));
      if (!adapter.withdraw) throw new WithdrawNotSentError("This version of the Polymarket adapter cannot withdraw.");
      try {
        await adapter.withdraw(makeSetupContext(bot.id, session.keystore, session.passphrase, prompts), acct, { to: bot.masterAddress, amount: Number(usdAmount.toFixed(2)) });
      } catch (error) {
        if (/^(nothing to withdraw|insufficient balance)/.test(message(error))) throw new WithdrawNotSentError(message(error));
        throw error;
      }
    },

    // Polymarket has no history to read. The transfer is one transaction, so the pUSD showing up in the wallet is the evidence, and the caller checks that.
    evidence: async () => "none",
  };
}
