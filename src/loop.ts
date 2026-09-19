// The run loop both strategies share: one cycle, one line, never crash, back
// off on errors, stop cleanly on Ctrl-C or SIGTERM without touching positions.
const MAX_BACKOFF_MS = 5 * 60_000;
const ONCE_REPORT_WAIT_MS = 20_000;

export interface LoopOptions {
  once: boolean;
  intervalSec: number;
  emit: (text: string) => void;
  cycle: () => Promise<string>;
  /** Started after every cycle, success or not, and never awaited by the loop. A failure inside it is ignored. */
  afterCycle?: (line: string, failed: boolean) => Promise<void>;
  stoppedMessage: string;
}

/** One venue's side of a bot: its cycle, the figures it can report, and the last thing it did. */
export interface VenueLoop<F> {
  cycle: () => Promise<string>;
  /** Null when the numbers are not trustworthy right now. */
  figures: () => Promise<F | null>;
  lastAction: () => string;
}

/**
 * Several loops in one process, each with its own cycle, wait and backoff, so an error or a HOLD in one never delays another.
 * Ctrl-C or SIGTERM stops them all. The exit code is the worst of theirs.
 */
export async function runLoops(loops: LoopOptions[]): Promise<number> {
  const codes = await Promise.all(loops.map((loop) => runLoop(loop)));
  return Math.max(0, ...codes);
}

export async function runLoop(opts: LoopOptions): Promise<number> {
  let stopping = false;
  let wake: (() => void) | undefined;
  const onSignal = (): void => {
    stopping = true;
    wake?.();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let reporting = false;
  const after = async (line: string, failed: boolean): Promise<void> => {
    if (!opts.afterCycle || reporting) return;
    reporting = true;
    try {
      await opts.afterCycle(line, failed);
    } catch {
      // Reporting never affects the loop.
    } finally {
      reporting = false;
    }
  };

  let delayMs = opts.intervalSec * 1000;
  let failed = false;
  while (!stopping) {
    let line = "";
    try {
      line = await opts.cycle();
      // An empty line means the cycle had nothing to say.
      if (line) opts.emit(line);
      delayMs = opts.intervalSec * 1000;
      failed = false;
    } catch (error) {
      // Never crash the loop. Say what happened, wait longer, try again.
      failed = true;
      delayMs = opts.once ? delayMs : Math.min(delayMs * 2, MAX_BACKOFF_MS);
      line = `Error. ${error instanceof Error ? error.message : String(error)}.`;
      opts.emit(`${line}${opts.once ? "" : ` Next attempt in ${Math.round(delayMs / 1000)} seconds.`}`);
    }
    // Reporting never holds up the loop: it runs beside the wait for the next cycle,
    // one at a time. Only --once waits for it, briefly, so the process can end after it.
    const reported = after(line, failed);
    if (opts.once) {
      await Promise.race([reported, new Promise<void>((resolve) => setTimeout(resolve, ONCE_REPORT_WAIT_MS).unref())]);
      break;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  if (stopping) opts.emit(opts.stoppedMessage);
  return opts.once && failed ? 1 : 0;
}
