// strats run on Polymarket: the markets matching the creator's theme, the games
// of the creator's team, or a single asset's markets beside its perp. Each cycle
// reads the config (cached), the targets, the wallet and the books, asks the pure
// reconcileTheme function what to do, and does it. The source object says where
// the settings and targets come from and which markets the bot may trade;
// everything else is the same loop.
import type { Args } from "../args.js";
import { runLoop, type VenueLoop } from "../loop.js";
import { appendLog } from "../paths.js";
import { sourceFor, type PolymarketConfigDoc, type PolymarketSource } from "../polymarket-source.js";
import type { ThemeMarket } from "../protocol/index.js";
import { describeThemeDecision, reconcileTheme, themeHoldReason, type ThemeTargetsInput } from "../reconcile-theme.js";
import { Reporter, polymarketPositions, publishedWalletAddress, toReportTrade, type ReportFigures } from "../report.js";
import { appendTrade, loadRuntimeState, saveRuntimeState, type StateScope } from "../runtime-state.js";
import { loadPolymarketCreds, scrub, sessionSecrets, type Session } from "../session.js";
import { marketsStateScope, pinnedDifferences } from "../state.js";
import { PolymarketVenue, polymarketGeoblock, type PmActionResult, type PolymarketSnapshot } from "../venue-polymarket.js";

const CONFIG_REFRESH_MS = 5 * 60_000;
const GEOBLOCK_RECHECK_MS = 15 * 60_000;
/** After an order whose result is unknown, the same market is left alone this long. */
const UNCERTAIN_COOLDOWN_MS = 15 * 60_000;

export interface ThemeRunOptions {
  dryRun: boolean;
  once: boolean;
  intervalSec: number;
  report: boolean;
}

export async function runTheme(_args: Args, session: Session, opts: ThemeRunOptions): Promise<number> {
  const { bot } = session;
  const { dryRun } = opts;
  const source = sourceFor(bot);
  const tag = source.label;
  if (!bot.polymarket) throw new Error("This bot has no Polymarket account yet. Run: strats init");
  // Polymarket reads need the signed client, so a dry run loads the credentials too. It gets a venue that refuses every order.
  const creds = loadPolymarketCreds(session);
  const venue = new PolymarketVenue(bot.polymarket, creds, { readOnly: dryRun });
  const secrets = [...sessionSecrets(session), creds.signerPk, creds.l2.secret, creds.l2.passphrase, creds.l2.apiKey];
  const deployed = session.runtime !== undefined;

  const emit = (text: string): void => {
    const line = scrub(`${new Date().toISOString()}  ${dryRun ? "dry run  " : ""}${text}`, secrets);
    console.log(line);
    // On a droplet the journal keeps the log.
    if (!deployed) appendLog(bot.id, line);
  };

  const reporter = new Reporter(session.gateway, source.strategyId, bot.id, opts.report && !dryRun);
  const loop = marketsLoop(session, { source, venue, dryRun, emit, reporter });

  if (!opts.once) emit(`Started ${tag} bot "${bot.id}" for Polymarket wallet ${bot.polymarket.funder}. ${dryRun ? "Nothing will be signed or sent." : "Orders are live."} Ceiling ${bot.ceilingPct}%.`);
  return runLoop({
    once: opts.once, intervalSec: opts.intervalSec, emit, cycle: loop.cycle,
    stoppedMessage: "Stopped. Positions were left as they are on Polymarket.",
    afterCycle: async (line) => {
      const failure = await reporter.maybeSend(Date.now(), scrub(loop.lastAction() || line.replace(/^(theme|team)\s+/, ""), secrets), loop.figures);
      if (failure) emit(failure);
    },
  });
}

/**
 * The Polymarket side of a single-asset bot that also trades markets, for strats run to put beside the perp loop.
 * Undefined when it cannot start; the reason is said once and the perp runs alone.
 */
export async function assetMarketsLoop(session: Session, opts: { dryRun: boolean; emit: (text: string) => void; reporter: Reporter; secrets: Array<string | undefined> }): Promise<VenueLoop<ReportFigures> | undefined> {
  const { bot } = session;
  try {
    if (!bot.polymarket) throw new Error("This bot has no Polymarket account yet. Run: strats init");
    const creds = loadPolymarketCreds(session);
    opts.secrets.push(creds.signerPk, creds.l2.secret, creds.l2.passphrase, creds.l2.apiKey);
    const venue = new PolymarketVenue(bot.polymarket, creds, { readOnly: opts.dryRun });
    // The perp loop already says when the pinned payout settings differ.
    return marketsLoop(session, { source: sourceFor(bot), venue, dryRun: opts.dryRun, emit: opts.emit, reporter: opts.reporter, scope: marketsStateScope(bot), quietPinned: true, readWhenIdle: true });
  } catch (error) {
    opts.emit(`markets  Off. ${error instanceof Error ? error.message : String(error)} The perp runs without them.`);
    return undefined;
  }
}

export interface MarketsLoopOptions {
  source: PolymarketSource;
  venue: PolymarketVenue;
  dryRun: boolean;
  emit: (text: string) => void;
  reporter: Reporter;
  /** Where the counters are kept. A two-venue bot keeps them apart from its Hyperliquid counters. */
  scope?: StateScope;
  /** True when another loop in this process already warns about the pinned payout settings. */
  quietPinned?: boolean;
  /** True when the figures are part of another venue's report: a side that has read nothing yet reads the wallet once, so the total is whole. */
  readWhenIdle?: boolean;
}

/** One Polymarket loop: its cycle, the figures it can report, and the last thing it did. */
export function marketsLoop(session: Session, opts: MarketsLoopOptions): VenueLoop<ReportFigures> {
  const { bot } = session;
  const { source, venue, dryRun, emit, reporter, scope } = opts;
  const tag = source.label;
  let config: PolymarketConfigDoc | undefined;
  let configProblem = "";
  let configAt = 0;
  let warnedVersion: number | undefined;
  let blockedAt = 0;
  let blocked = false;
  let lastSnap: PolymarketSnapshot | undefined;
  /** The markets of the last cycle that read the targets, for the report. */
  let lastMarkets: ThemeMarket[] = [];
  let lastAction = "";
  /** An order was acknowledged after the snapshot the report would read, so the early report waits for the next snapshot. */
  let tradedSinceSnapshot = false;

  const cycle = async (): Promise<string> => {
    const now = Date.now();
    // Polymarket refuses orders from some countries, the United States among them. One cheap public check, repeated rarely.
    if (!dryRun && (blockedAt === 0 || (blocked && now - blockedAt >= GEOBLOCK_RECHECK_MS))) {
      const answer = await polymarketGeoblock();
      const was = blocked;
      blocked = answer?.blocked === true;
      blockedAt = now;
      if (blocked && !was) return `${tag}  Holding. Polymarket does not accept orders from ${answer!.country}. Run strats deploy to place the runner in a region where it can trade. Nothing is opened or closed from here.`;
    }
    // Said once. Until the next check the runner idles: nothing is read, opened or closed.
    if (blocked) return "";

    if (!config || now - configAt >= CONFIG_REFRESH_MS) {
      const fetched = await source.fetchConfig(session.gateway);
      configAt = now;
      if (fetched.ok) {
        config = fetched.value;
        const differences = pinnedDifferences(bot.pinned, config.config.account);
        if (differences.length > 0 && warnedVersion !== config.version && opts.quietPinned !== true) {
          warnedVersion = config.version;
          emit(`Warning. The payout settings on the server differ from the pinned ones (${differences.join("; ")}). The pinned values stay in force. To adopt the change, run: strats config accept`);
        }
      } else {
        configProblem = fetched.message;
      }
    }

    const fetched = await source.fetchTargets(session.gateway);
    // HOLD needs no venue read: nothing is opened and nothing is closed.
    const hold = (held: ThemeTargetsInput): string => `${tag}  ${describeThemeDecision(reconcileTheme({ ...EMPTY, targets: held, now }), dryRun)}`;
    if (!fetched.ok) return hold({ ok: false, reason: fetched.message });
    // A team bot checks each game against the settings here. A game that fails is left out, so its target is refused below.
    const allowed = source.marketsFor(config, fetched.value);
    const targets: ThemeTargetsInput & { ok: true } = { ok: true, doc: allowed.doc };
    if (themeHoldReason(targets, now) !== null) return hold(targets);

    const { markets } = allowed;
    lastMarkets = markets;
    const refusals = allowed.refused.length > 0 ? ` ${allowed.refused.slice(0, 3).join(" ")}` : "";
    const snap = await venue.snapshot(markets, allowed.quoteTokenIds);
    lastSnap = snap;
    if (tradedSinceSnapshot) {
      // This snapshot shows the position the last order made, so the report that follows this cycle is sent early.
      tradedSinceSnapshot = false;
      reporter.requestPrompt();
    }

    const state = loadRuntimeState(bot.id, scope);
    if (state.netDepositsUsd === undefined && snap.equityUsd > 0) {
      // Polymarket has no deposit history to read. Profit is measured from the first wallet value the runner sees.
      state.netDepositsUsd = snap.equityUsd;
      state.netDepositsAt = new Date().toISOString();
      saveRuntimeState(bot.id, state, scope);
    }
    const recentlyAttempted = Object.entries(state.attempted).filter(([, at]) => now - Date.parse(at) < UNCERTAIN_COOLDOWN_MS).map(([id]) => id);
    const decision = reconcileTheme({
      targets, now: Date.now(), markets,
      holdings: snap.holdings, quotes: snap.quotes,
      collateralUsd: snap.collateralUsd, equityUsd: snap.equityUsd, exposureUsd: snap.exposureUsd,
      positionPct: config?.config.account.positionPct ?? 0, ceilingPct: bot.ceilingPct,
      blockedTargetIds: [...Object.keys(state.entered), ...recentlyAttempted],
      redeemedConditionIds: Object.keys(state.redeemed),
      pendingTokenIds: snap.pendingTokenIds,
      ...(config ? {} : { openBlockedReason: `The settings could not be loaded (${configProblem}) Not opening.` }),
    });
    if (dryRun || decision.actions.length === 0) return `${tag}  ${describeThemeDecision(decision, dryRun)}${refusals}`;

    const marketOf = (conditionId: string) => markets.find((m) => m.conditionId.toLowerCase() === conditionId.toLowerCase());
    // The report runs beside the cycle and records its own time in the same file; keep it when saving this copy.
    const save = (): void => {
      const reportedAt = loadRuntimeState(bot.id, scope).lastReportAt;
      if (reportedAt) state.lastReportAt = reportedAt;
      saveRuntimeState(bot.id, state, scope);
    };
    const texts: string[] = [];
    // Display only: the last trades this runner made, for the report.
    const remember = (result: PmActionResult, question: string | undefined): void => {
      if (!result.trade) return;
      const trade = toReportTrade({ at: Date.now(), label: question || "Polymarket market", ...result.trade });
      if (trade) state.trades = appendTrade(state.trades, trade);
      tradedSinceSnapshot = true;
    };
    for (const action of decision.actions) {
      const stamp = new Date().toISOString();
      if (action.kind === "redeem") {
        // Recorded before it is sent: a redemption is never submitted twice, whatever happens next.
        state.redeemed[action.conditionId] = stamp;
        save();
        const result = await venue.redeem(action, marketOf(action.conditionId), snap);
        remember(result, marketOf(action.conditionId)?.question);
        texts.push(result.text);
      } else if (action.kind === "sell") {
        const result = await venue.sell(action, marketOf(action.conditionId));
        state.volumeUsd += result.filledUsd;
        remember(result, marketOf(action.conditionId)?.question);
        texts.push(result.text);
      } else {
        const market = marketOf(action.conditionId);
        if (!market) continue;
        const result = await venue.buy(action, market, snap);
        state.volumeUsd += result.filledUsd;
        if (result.filledUsd > 0) state.entered[action.targetId] = stamp;
        if (result.uncertain) state.attempted[action.targetId] = stamp;
        remember(result, market.question || action.question);
        texts.push(result.text);
      }
      save();
    }
    lastAction = texts.join(" ");
    return `${tag}  ${lastAction}${refusals}`;
  };

  const figures = async (): Promise<ReportFigures | null> => {
    // A side that has held since it started has read nothing. Its wallet is read here, read-only, so a shared report counts it.
    if (!lastSnap && opts.readWhenIdle === true) {
      if (lastMarkets.length === 0 && config && "markets" in config.config.strategy) lastMarkets = config.config.strategy.markets ?? [];
      lastSnap = await venue.snapshot(lastMarkets, []);
    }
    if (!lastSnap) return null;
    const state = loadRuntimeState(bot.id, scope);
    const markets = lastMarkets;
    const configured = new Set(markets.flatMap((m) => m.tokenIds));
    return {
      venue: "polymarket",
      equityUsd: lastSnap.equityUsd,
      netDepositsUsd: state.netDepositsUsd ?? lastSnap.equityUsd,
      volumeUsd: state.volumeUsd,
      openPositions: lastSnap.holdings.filter((h) => configured.has(h.tokenId)).length,
      positions: polymarketPositions(lastSnap.holdings, markets),
      trades: state.trades,
      walletAddress: publishedWalletAddress(bot),
    };
  };

  return { cycle, figures, lastAction: () => lastAction };
}

/** Wallet fields for a cycle that holds before reading the venue. reconcileTheme returns hold before it looks at them. */
const EMPTY = {
  markets: [], holdings: [], quotes: {}, collateralUsd: 0, equityUsd: 0, exposureUsd: 0, positionPct: 0, ceilingPct: 0,
  blockedTargetIds: [], redeemedConditionIds: [], pendingTokenIds: [],
};
