// strats run for a theme bot: Polymarket markets matching the creator's theme.
// Each cycle reads the config (cached), the targets, the wallet and the books,
// asks the pure reconcileTheme function what to do, and does it.
import type { Args } from "../args.js";
import { fetchThemeConfig, fetchThemeTargets } from "../client.js";
import { runLoop } from "../loop.js";
import { appendLog } from "../paths.js";
import type { ThemeConfigDoc } from "../protocol/index.js";
import { describeThemeDecision, reconcileTheme, themeHoldReason, type ThemeTargetsInput } from "../reconcile-theme.js";
import { Reporter, polymarketPositions, publishedWalletAddress, toReportTrade } from "../report.js";
import { appendTrade, loadRuntimeState, saveRuntimeState } from "../runtime-state.js";
import { loadPolymarketCreds, scrub, sessionSecrets, type Session } from "../session.js";
import { pinnedDifferences } from "../state.js";
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

  let config: ThemeConfigDoc | undefined;
  let configProblem = "";
  let configAt = 0;
  let warnedVersion: number | undefined;
  let blockedAt = 0;
  let blocked = false;
  let lastSnap: PolymarketSnapshot | undefined;
  let lastAction = "";
  /** An order was acknowledged after the snapshot the report would read, so the early report waits for the next snapshot. */
  let tradedSinceSnapshot = false;
  const reporter = new Reporter(session.gateway, "theme", bot.id, opts.report && !dryRun);

  const cycle = async (): Promise<string> => {
    const now = Date.now();
    // Polymarket refuses orders from some countries, the United States among them. One cheap public check, repeated rarely.
    if (!dryRun && (blockedAt === 0 || (blocked && now - blockedAt >= GEOBLOCK_RECHECK_MS))) {
      const answer = await polymarketGeoblock();
      const was = blocked;
      blocked = answer?.blocked === true;
      blockedAt = now;
      if (blocked && !was) return `theme  Holding. Polymarket does not accept orders from ${answer!.country}. Run strats deploy to place the runner in a region where it can trade. Nothing is opened or closed from here.`;
    }
    // Said once. Until the next check the runner idles: nothing is read, opened or closed.
    if (blocked) return "";

    if (!config || now - configAt >= CONFIG_REFRESH_MS) {
      const fetched = await fetchThemeConfig(session.gateway);
      configAt = now;
      if (fetched.ok) {
        config = fetched.value;
        const differences = pinnedDifferences(bot.pinned, config.config.account);
        if (differences.length > 0 && warnedVersion !== config.version) {
          warnedVersion = config.version;
          emit(`Warning. The payout settings on the server differ from the pinned ones (${differences.join("; ")}). The pinned values stay in force. To adopt the change, run: strats config accept`);
        }
      } else {
        configProblem = fetched.message;
      }
    }

    const fetched = await fetchThemeTargets(session.gateway);
    const targets: ThemeTargetsInput = fetched.ok ? { ok: true, doc: fetched.value } : { ok: false, reason: fetched.message };
    // HOLD needs no venue read: nothing is opened and nothing is closed.
    if (!targets.ok || themeHoldReason(targets, now) !== null) {
      return `theme  ${describeThemeDecision(reconcileTheme({ ...EMPTY, targets, now }), dryRun)}`;
    }

    const markets = config?.config.strategy.markets ?? [];
    const tokenIds = [...targets.doc.targets.map((t) => t.tokenId), ...targets.doc.closed.map((c) => c.tokenId)];
    const snap = await venue.snapshot(markets, tokenIds);
    lastSnap = snap;
    if (tradedSinceSnapshot) {
      // This snapshot shows the position the last order made, so the report that follows this cycle is sent early.
      tradedSinceSnapshot = false;
      reporter.requestPrompt();
    }

    const state = loadRuntimeState(bot.id);
    if (state.netDepositsUsd === undefined && snap.equityUsd > 0) {
      // Polymarket has no deposit history to read. Profit is measured from the first wallet value the runner sees.
      state.netDepositsUsd = snap.equityUsd;
      saveRuntimeState(bot.id, state);
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
    if (dryRun || decision.actions.length === 0) return `theme  ${describeThemeDecision(decision, dryRun)}`;

    const marketOf = (conditionId: string) => markets.find((m) => m.conditionId.toLowerCase() === conditionId.toLowerCase());
    // The report runs beside the cycle and records its own time in the same file; keep it when saving this copy.
    const save = (): void => {
      const reportedAt = loadRuntimeState(bot.id).lastReportAt;
      if (reportedAt) state.lastReportAt = reportedAt;
      saveRuntimeState(bot.id, state);
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
    return `theme  ${lastAction}`;
  };

  if (!opts.once) emit(`Started theme bot "${bot.id}" for Polymarket wallet ${bot.polymarket.funder}. ${dryRun ? "Nothing will be signed or sent." : "Orders are live."} Ceiling ${bot.ceilingPct}%.`);
  return runLoop({
    once: opts.once, intervalSec: opts.intervalSec, emit, cycle,
    stoppedMessage: "Stopped. Positions were left as they are on Polymarket.",
    afterCycle: async (line) => {
      const failure = await reporter.maybeSend(Date.now(), scrub(lastAction || line.replace(/^theme\s+/, ""), secrets), async () => {
        if (!lastSnap) return null;
        const state = loadRuntimeState(bot.id);
        const markets = config?.config.strategy.markets ?? [];
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
      });
      if (failure) emit(failure);
    },
  });
}

/** Wallet fields for a cycle that holds before reading the venue. reconcileTheme returns hold before it looks at them. */
const EMPTY = {
  markets: [], holdings: [], quotes: {}, collateralUsd: 0, equityUsd: 0, exposureUsd: 0, positionPct: 0, ceilingPct: 0,
  blockedTargetIds: [], redeemedConditionIds: [], pendingTokenIds: [],
};
