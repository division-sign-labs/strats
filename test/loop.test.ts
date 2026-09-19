import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runLoop } from "../src/loop.js";

describe("runLoop", () => {
  it("never waits for the report: cycles keep running while one is still in flight, and only one runs at a time", async () => {
    let cycles = 0;
    let reportsStarted = 0;
    let release: (() => void) | undefined;
    const done = runLoop({
      once: false, intervalSec: 0.01, emit: () => undefined, stoppedMessage: "stopped",
      cycle: async () => {
        cycles += 1;
        if (cycles === 5) process.emit("SIGTERM");
        return `cycle ${cycles}`;
      },
      // A report that never finishes on its own.
      afterCycle: () => new Promise<void>((resolve) => {
        reportsStarted += 1;
        release = resolve;
      }),
    });
    assert.equal(await done, 0);
    assert.ok(cycles >= 5);
    assert.equal(reportsStarted, 1);
    release?.();
  });

  it("a report that throws changes nothing", async () => {
    const lines: string[] = [];
    const code = await runLoop({
      once: true, intervalSec: 1, emit: (t) => lines.push(t), stoppedMessage: "stopped",
      cycle: async () => "ok",
      afterCycle: async () => {
        throw new Error("report failed");
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(lines, ["ok"]);
  });
});
