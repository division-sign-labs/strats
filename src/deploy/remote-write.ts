// Adapted from classy-cassie packages/cli/src/remote-write.ts (Apache-2.0, Quotient).
// One shell string for writing a file on a droplet from stdin: content never
// touches argv or the process list, and a dropped connection cannot leave a
// half-written file because the move is the last step.

export function remoteWriteCommand(path: string, mode: string, owner: string): string {
  for (const value of [path, mode, owner]) {
    if (!/^[A-Za-z0-9_@./:-]+$/.test(value)) throw new Error("remote write: unexpected character in path, mode or owner");
  }
  const tmp = `${path}.tmp`;
  return `umask 077 && cat > '${tmp}' && chown ${owner} '${tmp}' && chmod ${mode} '${tmp}' && mv '${tmp}' '${path}'`;
}
