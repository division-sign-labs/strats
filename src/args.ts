// Hand-rolled argv parsing. Flags are declared up front so a typo is an error, not a silent default.
export interface Args {
  command: string;
  positionals: string[];
  /** --name value */
  values: Record<string, string | undefined>;
  /** --name */
  flags: Set<string>;
}

export class UsageError extends Error {}

const VALUE_FLAGS = new Set(["key", "ceiling", "id", "gateway", "interval", "force-side", "coin", "dex", "region", "size", "lines"]);
const BOOLEAN_FLAGS = new Set(["dry-run", "once", "force", "yes-place-a-real-order", "help", "version", "yes", "from-tarball", "no-report", "follow", "no-deploy"]);

export function parseArgs(argv: string[]): Args {
  const args: Args = { command: "", positionals: [], values: {}, flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "-h") {
      args.flags.add("help");
    } else if (token === "-y") {
      args.flags.add("yes");
    } else if (token === "-f") {
      args.flags.add("follow");
    } else if (token.startsWith("--")) {
      const [name = "", inline] = token.slice(2).split(/=(.*)/s, 2);
      if (BOOLEAN_FLAGS.has(name)) {
        if (inline !== undefined) throw new UsageError(`--${name} does not take a value.`);
        args.flags.add(name);
      } else if (VALUE_FLAGS.has(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined || value === "" || (inline === undefined && value.startsWith("--"))) throw new UsageError(`--${name} needs a value.`);
        args.values[name] = value;
      } else {
        throw new UsageError(`Unknown option --${name}.`);
      }
    } else if (!args.command) {
      args.command = token;
    } else {
      args.positionals.push(token);
    }
  }
  return args;
}
