// Terminal prompts and the SetupContext the cassie-core funding flow needs.
// Built on node:readline only. The passphrase is read once per command and
// kept in memory for that command; it is never written anywhere.
import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import { Keystore, WrongPassphraseError, isTransientVenueError, type SetupContext } from "@quotient-forecasting/cassie-core";
import { ensurePrivateDir, keysDir } from "./paths.js";

export const MIN_PASSPHRASE_LENGTH = 8;

export class Prompts {
  private rl?: Interface;
  private muted = false;
  /** Printed when Ctrl-C stops a command at a prompt or during a wait. A command sets it to say how to continue. */
  interruptMessage = "Stopped.";

  get interactive(): boolean {
    return process.stdin.isTTY === true;
  }

  private line(): Interface {
    if (!this.interactive) throw new Error("This step needs a terminal. For unattended use, pass the value as a flag or set STRATS_PASSPHRASE.");
    if (!this.rl) {
      // Output goes through a gate so a secret is not echoed while it is typed.
      const output = new Writable({
        write: (chunk, _encoding, done) => {
          if (!this.muted) process.stdout.write(chunk);
          done();
        },
      });
      this.rl = createInterface({ input: process.stdin, output, terminal: true });
      // While a prompt is open the terminal hands Ctrl-C to readline, which would only pause input.
      // Exit instead, so a long wait for a deposit can always be stopped and continued later.
      this.rl.on("SIGINT", () => {
        this.muted = false;
        process.stdout.write("\n");
        console.log(this.interruptMessage);
        process.exit(130);
      });
    }
    return this.rl;
  }

  async ask(question: string, opts: { secret?: boolean; default?: string } = {}): Promise<string> {
    const rl = this.line();
    const suffix = opts.default !== undefined && !opts.secret ? ` [${opts.default}]` : "";
    if (!opts.secret) return (await rl.question(`${question}${suffix}: `)).trim() || opts.default || "";
    process.stdout.write(`${question}: `);
    this.muted = true;
    try {
      return await rl.question("");
    } finally {
      this.muted = false;
      process.stdout.write("\n");
    }
  }

  async confirm(question: string, defaultYes = false): Promise<boolean> {
    const answer = (await this.ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}`)).toLowerCase();
    if (answer === "") return defaultYes;
    return answer === "y" || answer === "yes";
  }

  close(): void {
    this.rl?.close();
    this.rl = undefined;
  }
}

/** STRATS_PASSPHRASE for unattended use, otherwise a hidden prompt. */
export async function readPassphrase(prompts: Prompts, opts: { create?: boolean } = {}): Promise<string> {
  const fromEnv = process.env.STRATS_PASSPHRASE;
  if (fromEnv !== undefined && fromEnv !== "") {
    if (opts.create && fromEnv.length < MIN_PASSPHRASE_LENGTH) throw new Error(`STRATS_PASSPHRASE must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
    return fromEnv;
  }
  if (!opts.create) return prompts.ask("Keystore passphrase", { secret: true });
  for (;;) {
    const first = await prompts.ask(`Choose a keystore passphrase (at least ${MIN_PASSPHRASE_LENGTH} characters)`, { secret: true });
    if (first.length < MIN_PASSPHRASE_LENGTH) {
      console.log(`The passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
      continue;
    }
    if ((await prompts.ask("Repeat the passphrase", { secret: true })) === first) return first;
    console.log("The two entries did not match.");
  }
}

export function openKeystore(): Keystore {
  ensurePrivateDir(keysDir());
  return new Keystore(keysDir());
}

/** Read one secret, turning the two failure shapes of the keystore into plain errors. */
export function readSecret(keystore: Keystore, botId: string, role: string, passphrase: string): string | null {
  try {
    return keystore.getEntry(botId, role, passphrase);
  } catch (error) {
    if (error instanceof WrongPassphraseError) throw new Error("Wrong passphrase, or the keystore file is damaged.");
    throw error;
  }
}

/** verifyPassphrase throws on a wrong passphrase and returns false only when no keystore exists. */
export function checkPassphrase(keystore: Keystore, botId: string, passphrase: string): void {
  try {
    if (!keystore.verifyPassphrase(botId, passphrase)) throw new Error(`No keystore for bot "${botId}". Run strats init first.`);
  } catch (error) {
    if (error instanceof WrongPassphraseError) throw new Error("Wrong passphrase, or the keystore file is damaged.");
    throw error;
  }
}

/** The SetupContext handed to the adapter's funding flow. Secrets go to and from the encrypted keystore only. */
export function makeSetupContext(botId: string, keystore: Keystore, passphrase: string, prompts: Prompts, opts: { skipDepositWait?: boolean } = {}): SetupContext {
  return {
    // The funds are already there, so the flow goes straight to its checks instead of waiting for another deposit.
    ...(opts.skipDepositWait ? { pollSkippable: async () => null } : {}),
    botId,
    ask: (question, opts) => prompts.ask(question, opts),
    confirm: (question, defaultYes) => prompts.confirm(question, defaultYes),
    print: (text) => console.log(text),
    async poll(waitingMsg, check, opts = {}) {
      const interval = opts.intervalMs ?? 15_000;
      // The deposit-credit wait passes no timeout, so the default must be generous.
      const deadline = Date.now() + (opts.timeoutMs ?? 60 * 60_000);
      console.log(waitingMsg);
      for (;;) {
        let result = null;
        try {
          result = await check();
        } catch (error) {
          // A deferred or rate-limited read is "not ready yet", not a reason to abandon a deposit in flight.
          if (!isTransientVenueError(error)) throw error;
        }
        if (result !== null) return result;
        if (Date.now() > deadline) throw new Error(`Timed out: ${waitingMsg}`);
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    },
    getSecret: async (role) => readSecret(keystore, botId, role, passphrase),
    // putEntry is synchronous and fsyncs before it returns, so the agent key is durable before the venue approval.
    putSecret: async (role, value, meta = {}) => keystore.putEntry(botId, role, value, passphrase, meta),
  };
}
