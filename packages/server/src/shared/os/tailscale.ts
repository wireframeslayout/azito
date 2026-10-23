import { execFile } from 'child_process';

/**
 * Where the tailscale CLI is looked for, in order: PATH first, then the places Homebrew installs it. A Mac reached over
 * SSH (or a launchd service) has a minimal PATH without `/opt/homebrew/bin` (Apple silicon) and `/usr/local/bin` (Intel),
 * so the known locations are tried in turn instead of rewriting PATH. A location that does not exist is skipped on ENOENT;
 * any other failure (the CLI ran and failed) is the answer.
 */
export const TAILSCALE_COMMANDS: readonly string[] = ['tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];

/** Runs `tailscale <args>` from the first location that has it and returns its stdout. Rejects with the last ENOENT when none has. */
export async function runTailscale(args: string[], timeoutMs: number): Promise<string> {
  let lastError: unknown;
  for (const command of TAILSCALE_COMMANDS) {
    try {
      return await new Promise<string>((resolve, reject) => {
        execFile(command, args, { timeout: timeoutMs }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      lastError = err;
    }
  }
  throw lastError;
}
