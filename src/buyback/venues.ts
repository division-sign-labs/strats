// The venue side of a buyback: what the account is worth, what was deposited,
// what is free to withdraw, and the withdrawal itself. The withdrawal always
// goes to the bot's own wallet address, read from the bot file. No flag, no
// document from Quotient and no quote can change where it goes.
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { KeyRoles, type SetupContext } from "@quotient-forecasting/cassie-core";
import { privateKeyToAccount } from "viem/accounts";
import { depositsLessWithdrawals, type PayoutSummary } from "../payouts.js";
import { loadRuntimeState } from "../runtime-state.js";
import { loadPolymarketCreds, loadWalletKey, type Session } from "../session.js";
import { makeSetupContext, type Prompts } from "../setup.js";
import { buildAdapter } from "../venue.js";
import { PolymarketVenue, buildPolymarketAdapter } from "../venue-polymarket.js";
import type { Journal } from "./journal.js";
import { WithdrawNotSentError, type VenuePort } from "./machine.js";

/** Said instead of a plan, with exit code 1. */
export class BuybackRefusal extends Error {}

/** The venue's figures, refused unless every one is a number: NaN or Infinity must never reach the arithmetic. */
export async function checkedFigures(venue: Pick<BuybackVenuePort, "figures">, payouts: PayoutSummary): Promise<VenueFigures> {
  const figures = await venue.figures(payouts);
  if (![figures.equityUsd, figures.freeUsd, figures.basisUsd].every(Number.isFinite)) {
    throw new BuybackRefusal("The venue's figures could not be read (wallet value, free collateral or deposits was not a number). Try again.");
  }
  return figures;
}

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

/**
 * What the adapter's withdrawal is handed. On the creator's machine it reads the keystore, as before. On a droplet that buys back
 * by itself there is no keystore and no terminal: it answers the one thing a withdrawal asks for, the wallet key, stores nothing,
 * and refuses every question, because nobody is there to answer one.
 */
export function withdrawalContext(session: Session, prompts: Prompts | undefined): SetupContext {
  if (session.keystore && session.passphrase !== undefined && prompts) return makeSetupContext(session.bot.id, session.keystore, session.passphrase, prompts);
  const nobody = async (): Promise<never> => {
    throw new Error("This step asked a question, and nobody is at the droplet to answer it.");
  };
  return {
    botId: session.bot.id,
    ask: nobody, confirm: nobody, poll: nobody,
    print: () => undefined,
    getSecret: async (role) => (role === KeyRoles.master ? loadWalletKey(session) : null),
    putSecret: async () => {
      throw new Error("Nothing is stored on the droplet.");
    },
  };
}

/** Where a Polymarket bot's deposits figure comes from. The creator's machine reads its own record; the droplet reads what strats deploy sent. */
export type DepositsSource = () => { netDepositsUsd?: number | undefined; netDepositsAt?: string | undefined };

export function hyperliquidVenue(session: Session, dex: string, prompts?: Prompts): BuybackVenuePort {
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
        let masterPk: string | null;
        try {
          masterPk = loadWalletKey(session);
        } catch (error) {
          throw new WithdrawNotSentError(message(error));
        }
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
        const inMain = async (): Promise<boolean> => {
          const main = await info.clearinghouseState({ user }).catch(() => null);
          return main !== null && Number(main.withdrawable) + 0.005 >= amount;
        };
        // An earlier run may have moved the money and then been refused. It is withdrawn from there, never moved a second time.
        if (await inMain()) {
          moved = true;
        } else {
          try {
            await new ExchangeClient({ transport, wallet: privateKeyToAccount(masterPk as `0x${string}`) })
              .sendAsset({ destination: user, sourceDex: dex, destinationDex: "", token, amount: amount.toFixed(2), fromSubAccount: "" });
          } catch (error) {
            if (venueRefused(error)) throw new WithdrawNotSentError(message(error));
            throw error;
          }
          moved = true;
          // The main account shows the money within a moment. Withdrawing before it does would be refused.
          let shown = false;
          for (let attempt = 0; attempt < 15 && !shown; attempt++) {
            shown = await inMain();
            if (!shown) await new Promise((resolve) => setTimeout(resolve, 2_000));
          }
          if (!shown) throw new WithdrawNotSentError("the main Hyperliquid account did not show the money yet", true);
        }
      }
      try {
        await adapter.withdraw(withdrawalContext(session, prompts), acct, { to: bot.masterAddress, amount });
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

export function polymarketVenue(session: Session, prompts?: Prompts, deposits: DepositsSource = () => loadRuntimeState(session.bot.id)): BuybackVenuePort {
  const { bot } = session;
  if (!bot.polymarket) throw new BuybackRefusal("This bot has no Polymarket account yet. Run: strats init");
  const account = bot.polymarket;
  const acct = { venue: "polymarket" as const, ...account };

  return {
    name: "polymarket",
    label: "Polymarket",

    async figures(payouts) {
      const state = deposits();
      if (state.netDepositsUsd === undefined) {
        throw new BuybackRefusal(session.runtime
          ? "The droplet was sent no deposits figure. On your own machine run strats fund, or strats buyback --set-deposits <usd>, then strats buyback --sync"
          : "This machine has no record of what was deposited. Run strats fund here, or: strats buyback --set-deposits <usd>");
      }
      // Free collateral plus the positions Polymarket lists. A position it does not list is left out, which can only lower the payout.
      const snap = await new PolymarketVenue(account, loadPolymarketCreds(session), { readOnly: true }).snapshot([], []);
      return { equityUsd: snap.equityUsd, freeUsd: snap.collateralUsd, basisUsd: depositsLessWithdrawals(state.netDepositsUsd, state.netDepositsAt, payouts.withdrawals) };
    },

    async withdraw(usdAmount) {
      const adapter = buildPolymarketAdapter(loadPolymarketCreds(session));
      if (!adapter.withdraw) throw new WithdrawNotSentError("This version of the Polymarket adapter cannot withdraw.");
      try {
        await adapter.withdraw(withdrawalContext(session, prompts), acct, { to: bot.masterAddress, amount: Number(usdAmount.toFixed(2)) });
      } catch (error) {
        if (/^(nothing to withdraw|insufficient balance)/.test(message(error))) throw new WithdrawNotSentError(message(error));
        throw error;
      }
    },

    // Polymarket has no history to read. The transfer is one transaction, so the pUSD showing up in the wallet is the evidence, and the caller checks that.
    evidence: async () => "none",
  };
}
