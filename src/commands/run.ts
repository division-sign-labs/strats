// strats run: the loop. Each cycle reads the config (cached), the target and
// the venue from scratch, asks the pure reconcile function what to do, does
// that one thing, and prints one line. Nothing is carried between cycles that
// the venue could not tell us again after a restart.
import { UsageError, type Args } from "../args.js";
import { fetchConfig, fetchTarget } from "../client.js";
import { appendLog } from "../paths.js";
import type { ConfigDoc, TargetDoc } from "../protocol/index.js";
import { describeDecision, holdReason, reconcile, type Decision, type ReconcileInput, type Side, type TargetInput } from "../reconcile.js";
import { loadAgentKey, openSession, scrub } from "../session.js";
import type { Prompts } from "../setup.js";
import { pinnedDifferences } from "../state.js";
import { Venue, toOrderView, toPositionView, type VenueSnapshot } from "../venue.js";

const CONFIG_REFRESH_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;
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
  // A dry run never loads a signing key, so it cannot sign. The master key is never loaded by run.
  const agentPk = dryRun ? undefined : loadAgentKey(session);
  prompts.close();

  let stopping = false;
  let wake: (() => void) | undefined;
  const onSignal = (): void => {
    stopping = true;
    wake?.();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let config: ConfigDoc | undefined;
  let configProblem = "";
  let configAt = 0;
  let warnedVersion: number | undefined;
  let forced: TargetDoc | undefined;
  let unprotectedSince: number | undefined;
  const venues = new Map<string, Venue>();

  const emit = (text: string): void => {
    const line = scrub(`${new Date().toISOString()}  ${dryRun ? "dry run  " : ""}${text}`, [session.gateway.apiKey, agentPk, session.passphrase]);
    console.log(line);
    appendLog(bot.id, line);
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
    if (decision.kind === "open") return `${tag}${(await venue.openPosition(decision, snap, target.doc.target)).text}`;
    if (decision.kind === "close") return `${tag}${(await venue.closePosition(snap)).text} ${decision.reason}`;
    return `${tag}${(await venue.repair(decision, snap)).text}`;
  };

  if (!once) emit(`Started bot "${bot.id}" for wallet ${bot.masterAddress}. ${dryRun ? "Nothing will be signed or sent." : "Orders are live."} Ceiling ${bot.ceilingPct}%.`);
  let delayMs = intervalSec * 1000;
  let failed = false;
  while (!stopping) {
    try {
      emit(await cycle());
      delayMs = intervalSec * 1000;
      failed = false;
    } catch (error) {
      // Never crash the loop. Say what happened, wait longer, try again.
      failed = true;
      delayMs = once ? delayMs : Math.min(delayMs * 2, MAX_BACKOFF_MS);
      emit(`Error. ${error instanceof Error ? error.message : String(error)}.${once ? "" : ` Next attempt in ${Math.round(delayMs / 1000)} seconds.`}`);
    }
    if (once) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  if (stopping) emit("Stopped. Positions and their stop and target orders were left as they are on Hyperliquid.");
  return once && failed ? 1 : 0;
}

/** Venue fields for a cycle that holds before reading the venue. reconcile returns hold before it looks at them. */
const EMPTY_INPUT: Omit<ReconcileInput, "target" | "now" | "dryRun"> = {
  position: null, openOrders: [], mid: 0, bid: 0, ask: 0, equityUsd: 0, positionPct: 0, ceilingPct: 0, instrument: { szDecimals: 0, minNotional: 0 },
};
