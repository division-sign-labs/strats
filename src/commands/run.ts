// strats run: the loop. Each cycle reads the config (cached), the target and
// the venue from scratch, asks the pure reconcile function what to do, does
// that one thing, and prints one line. Nothing is carried between cycles that
// the venue could not tell us again after a restart.
import { UsageError, type Args } from "../args.js";
import { fetchConfig, fetchTarget } from "../client.js";
import { runLoop } from "../loop.js";
import { appendLog } from "../paths.js";
import type { ConfigDoc, TargetDoc } from "../protocol/index.js";
import { describeDecision, holdReason, reconcile, type Decision, type ReconcileInput, type Side, type TargetInput } from "../reconcile.js";
import { Reporter } from "../report.js";
import { loadRuntimeState, saveRuntimeState } from "../runtime-state.js";
import { loadAgentKey, openSession, scrub, sessionSecrets } from "../session.js";
import type { Prompts } from "../setup.js";
import { pinnedDifferences } from "../state.js";
import { Venue, toOrderView, toPositionView, type VenueSnapshot } from "../venue.js";

const CONFIG_REFRESH_MS = 5 * 60_000;
/** A position that cannot get a stop for this long is closed. */
const UNPROTECTED_LIMIT_MS = 3 * 60_000;

type ForceSide = Side | "flat";

/** A test target built once from the live mid: target 2% away, stop 1.5% the other way, entry limit halfway, one hour to live. */
export function forcedTarget(real: TargetDoc, side: ForceSide, mid: number, now: number): TargetDoc {
  const base = { ...real, asOf: new Date(now).toISOString(), mode: "open" as const };
  if (side === "flat") {
    return { ...base, target: { ...real.target, side: "flat", flatReason: "neutral", entryLimit: null, targetPx: null, stopPx: null, expiresAt: null, signalId: null, revision: null, reason: "Forced flat for testing." } };
  }
  const direction = side === "long" ? 1 : -1;
  const level = (fraction: number): number => Number((mid * (1 + direction * fraction)).toPrecision(8));
  return {
    ...base,
    target: {
      ...real.target, side, flatReason: null,
      targetPx: level(0.02),
      stopPx: level(-0.015),
      entryLimit: level(0.01),
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
      signalId: `forced-${now}`, revision: 0,
      reason: `Forced ${side} for testing.`,
    },
  };
}

export function toReconcileInput(target: TargetInput, snap: VenueSnapshot, now: number, positionPct: number, ceilingPct: number, dryRun: boolean, openBlockedReason: string | undefined): ReconcileInput {
  const { quote, instrument } = snap.market;
  return {
    target, now, dryRun,
    position: toPositionView(snap.position),
    openOrders: snap.orders.map(toOrderView),
    mid: quote.mid, bid: quote.bid, ask: quote.ask,
    equityUsd: snap.equityUsd,
    positionPct, ceilingPct,
    instrument: { szDecimals: instrument.szDecimals, minNotional: instrument.minNotional },
    ...(openBlockedReason ? { openBlockedReason } : {}),
  };
}

export function openBlocked(config: ConfigDoc | undefined, configProblem: string, snap: VenueSnapshot): string | undefined {
  if (!config) return `The settings could not be loaded (${configProblem}) Not opening.`;
  if (snap.otherPositions.length > 0) return `The wallet also holds ${snap.otherPositions.map((p) => p.marketRef).join(", ")}, which this bot did not open. Not opening.`;
  if (!snap.standardMode) return `The Hyperliquid account mode is "${snap.accountMode}" and positions can only be opened in Standard mode. See "Account mode" in the README. Not opening.`;
  return undefined;
}

export async function run(args: Args, prompts: Prompts): Promise<number> {
  const dryRun = args.flags.has("dry-run");
  const once = args.flags.has("once");
  const intervalSec = Number(args.values.interval ?? 30);
  if (!Number.isFinite(intervalSec) || intervalSec < 5 || intervalSec > 300) throw new UsageError("--interval is in seconds, from 5 to 300.");
  const forceSide = args.values["force-side"] as ForceSide | undefined;
  if (forceSide !== undefined && !["long", "short", "flat"].includes(forceSide)) throw new UsageError("--force-side takes long, short or flat.");
  if (forceSide !== undefined && !dryRun && !args.flags.has("yes-place-a-real-order")) {
    throw new UsageError("--force-side ignores Q and trades a made-up target. Use it with --dry-run. To place a real order with it, add --yes-place-a-real-order.");
  }

  const session = await openSession(args, prompts);
  const { bot } = session;
  // One wallet, one runner. Two would each open the position.
  if (bot.deployment && !session.runtime && !dryRun && !args.flags.has("force")) {
    throw new Error(`Bot "${bot.id}" is deployed on ${bot.deployment.host}. Running it here too would trade the same wallet twice. Use strats logs or strats status, run strats destroy first, or pass --force if that droplet is gone.`);
  }
  const report = !args.flags.has("no-report");
  if (bot.strategyId === "theme") {
    if (forceSide !== undefined) throw new UsageError("--force-side applies to single-asset bots only.");
    prompts.close();
    return (await import("./run-theme.js")).runTheme(args, session, { dryRun, once, intervalSec, report });
  }
  // A dry run never loads a signing key, so it cannot sign. The master key is never loaded by run.
  const agentPk = dryRun ? undefined : loadAgentKey(session);
  prompts.close();

  let config: ConfigDoc | undefined;
  let configProblem = "";
  let configAt = 0;
  let warnedVersion: number | undefined;
  let forced: TargetDoc | undefined;
  let unprotectedSince: number | undefined;
  const venues = new Map<string, Venue>();
  let lastVenue: Venue | undefined;
  let lastSnap: VenueSnapshot | undefined;
  let lastAction = "";
  const deployed = session.runtime !== undefined;
  const reporter = new Reporter(session.gateway, "stock-ls", bot.id, report && !dryRun);

  const emit = (text: string): void => {
    const line = scrub(`${new Date().toISOString()}  ${dryRun ? "dry run  " : ""}${text}`, [...sessionSecrets(session), agentPk]);
    console.log(line);
    // On a droplet the journal keeps the log.
    if (!deployed) appendLog(bot.id, line);
  };

  const cycle = async (): Promise<string> => {
    const now = Date.now();
    if (!config || now - configAt >= CONFIG_REFRESH_MS) {
      const fetched = await fetchConfig(session.gateway);
      configAt = now;
      if (fetched.ok) {
        config = fetched.value;
        const differences = pinnedDifferences(bot.pinned, config.config.account);
        if (differences.length > 0 && warnedVersion !== config.version) {
          warnedVersion = config.version;
          emit(`Warning. The payout settings on the server differ from the pinned ones (${differences.join("; ")}). The pinned values stay in force. To adopt the change, run: strats config accept`);
        }
      } else {
        // Keep the last good config. Without one, the cycle can still manage or close, but not open.
        configProblem = fetched.message;
      }
    }

    const fetched = await fetchTarget(session.gateway);
    let target: TargetInput = fetched.ok ? { ok: true, doc: fetched.value } : { ok: false, reason: fetched.message };
    // HOLD needs no venue read: nothing is opened, nothing is closed, and the exits already resting stay put.
    if (!target.ok || (forceSide === undefined && holdReason(target, now) !== null)) {
      return `${target.ok ? target.doc.target.coin : config?.config.strategy.assetKey ?? "-"}  ${describeDecision(reconcile({ ...EMPTY_INPUT, target, now, dryRun }), "", dryRun)}`;
    }

    const { coin, dex } = target.doc.target;
    let venue = venues.get(coin);
    if (!venue) {
      venue = new Venue({ coin, dex, masterAddress: bot.masterAddress, ...(bot.agentAddress ? { agentAddress: bot.agentAddress } : {}), ...(agentPk ? { agentPk } : {}) });
      venues.set(coin, venue);
    }
    const snap = await venue.snapshot();
    lastVenue = venue;
    lastSnap = snap;
    if (forceSide !== undefined) {
      forced ??= forcedTarget(target.doc, forceSide, snap.market.quote.mid, now);
      // The forced levels are fixed for the life of the process; only its freshness moves.
      target = { ok: true, doc: { ...forced, validUntil: new Date(now + 60_000).toISOString() } };
    }

    const input = toReconcileInput(target, snap, Date.now(), config?.config.account.positionPct ?? 0, bot.ceilingPct, dryRun, openBlocked(config, configProblem, snap));
    let decision: Decision = reconcile(input);

    // A position that has gone without a stop for too long is closed rather than left exposed.
    if (decision.kind === "repair" && decision.placeStop !== undefined && snap.position) {
      unprotectedSince ??= now;
      if (now - unprotectedSince >= UNPROTECTED_LIMIT_MS) decision = { kind: "close", reason: "No stop could be placed for 3 minutes." };
    } else {
      unprotectedSince = undefined;
    }

    const tag = forceSide !== undefined ? `${coin}  forced ${forceSide}  ` : `${coin}  `;
    if (dryRun || decision.kind === "hold" || decision.kind === "none") return `${tag}${describeDecision(decision, coin, dryRun)}`;
    const acted = decision.kind === "open" ? (await venue.openPosition(decision, snap, target.doc.target)).text
      : decision.kind === "close" ? `${(await venue.closePosition(snap)).text} ${decision.reason}`
        : (await venue.repair(decision, snap)).text;
    lastAction = `${coin}: ${acted}`;
    return `${tag}${acted}`;
  };

  if (!once) emit(`Started bot "${bot.id}" for wallet ${bot.masterAddress}. ${dryRun ? "Nothing will be signed or sent." : "Orders are live."} Ceiling ${bot.ceilingPct}%.`);
  return runLoop({
    once, intervalSec, emit, cycle,
    stoppedMessage: "Stopped. Positions and their stop and target orders were left as they are on Hyperliquid.",
    afterCycle: async (line) => {
      const failure = await reporter.maybeSend(Date.now(), scrub(lastAction || line, [...sessionSecrets(session), agentPk]), async () => {
        if (!lastVenue || !lastSnap) return null;
        // A long hold reads nothing from the venue, so take a fresh reading for the totals. It is read-only.
        lastSnap = await lastVenue.snapshot();
        const since = Date.parse(bot.createdAt);
        const deposits = await lastVenue.netDeposits(since);
        // Without the full deposit history the profit figure would be wrong, so nothing is sent.
        if (!deposits.complete) return null;
        // Stops and targets fill while the runner is idle, so the venue's own fill history is the source. The stored figure never decreases.
        const state = loadRuntimeState(bot.id);
        const volumeUsd = Math.max(state.volumeUsd, await lastVenue.volumeSince(since).catch(() => 0));
        if (volumeUsd !== state.volumeUsd) saveRuntimeState(bot.id, { ...loadRuntimeState(bot.id), volumeUsd });
        return { venue: "hyperliquid", equityUsd: lastSnap.equityUsd, netDepositsUsd: deposits.amountUsd, volumeUsd, openPositions: lastSnap.position ? 1 : 0 };
      });
      if (failure) emit(failure);
    },
  });
}

/** Venue fields for a cycle that holds before reading the venue. reconcile returns hold before it looks at them. */
const EMPTY_INPUT: Omit<ReconcileInput, "target" | "now" | "dryRun"> = {
  position: null, openOrders: [], mid: 0, bid: 0, ask: 0, equityUsd: 0, positionPct: 0, ceilingPct: 0, instrument: { szDecimals: 0, minNotional: 0 },
};
