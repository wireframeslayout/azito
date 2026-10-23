import * as fs from 'fs';
import * as path from 'path';
import type { HostEnv } from '../../shared/os/hostEnv';
import type { SecretFileGuard } from '../../shared/os/secretFileGuardTypes';
import { shellQuote } from '../../shared/shellQuote';
import { ASKPASS_HELPER_SOURCE, ASKPASS_TOKEN_ENV, ASKPASS_USERNAME_ENV } from './askPassHelperSource';

/** The non-secret username the hub puts in a clone / push URL (the token is only the password). */
export const ASKPASS_USERNAME = 'x-access-token';

export type HubGitHostEnv = Pick<HostEnv, 'platform' | 'execPath'>;

/**
 * What the git commands that run on the HUB's own machine need that differs by OS:
 *  - `GIT_ASKPASS`: git runs the whole value as ONE executable, so it is a small launcher (Unix: sh, Windows: `.cmd`) that
 *    runs the shared Node helper with `HostEnv.execPath`. Neither file contains the token; it reaches the helper through the
 *    environment of the git child (`askPassEnv`).
 *  - `core.hooksPath`: an empty directory we own, instead of `/dev/null` (which Windows does not have).
 *
 * The files live in a directory only the current user can enter (`SecretFileGuard.ensureProtectedDir`) — another user must
 * not be able to swap the launcher, because the launcher is what receives the token.
 */
export class HubGitSupport {
  private readonly launcherPath: string;
  private readonly hooksDir: string;

  /**
   * `dir` is resolved once at startup (under the data directory, never the shared temp folder: a periodic temp cleaner
   * would delete it, and on a multi-user host another user could re-create files at a predictable temp path).
   * The contents are rewritten on every construction. A failure part-way removes what was written and rethrows.
   */
  constructor(
    private readonly hostEnv: HubGitHostEnv,
    private readonly guard: SecretFileGuard,
    readonly dir: string,
  ) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      this.guard.ensureProtectedDir(dir);

      const helperPath = path.join(dir, 'askpass.cjs');
      fs.writeFileSync(helperPath, ASKPASS_HELPER_SOURCE);

      const isWindows = hostEnv.platform === 'win32';
      this.launcherPath = path.join(dir, isWindows ? 'askpass.cmd' : 'askpass.sh');
      if (isWindows) {
        fs.writeFileSync(this.launcherPath, windowsLauncher(hostEnv.execPath, helperPath));
      } else {
        fs.writeFileSync(this.launcherPath, `#!/bin/sh\nexec ${shellQuote(hostEnv.execPath)} ${shellQuote(helperPath)} "$@"\n`, { mode: 0o700 });
      }

      this.hooksDir = path.join(dir, 'hooks');
      fs.mkdirSync(this.hooksDir);
    } catch (err) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the original error matters more */ }
      throw err;
    }
  }

  /** Environment entries for a git child that may ask for credentials. Spread over the base env of the git call. */
  askPassEnv(token: string): NodeJS.ProcessEnv {
    if (token === '') throw new Error('askPassEnv: token must not be empty');
    return {
      GIT_ASKPASS: this.launcherPath,
      [ASKPASS_TOKEN_ENV]: token,
      [ASKPASS_USERNAME_ENV]: ASKPASS_USERNAME,
    };
  }

  /** `-c core.hooksPath=<managed empty dir>`: git never runs a hook from the repository being operated on. */
  hooksPathArgs(): string[] {
    return ['-c', `core.hooksPath=${this.hooksDir}`];
  }
}

/** `%` would be expanded by cmd inside a batch file, and `"` cannot be in a Windows path; refuse rather than write a wrong launcher. */
function windowsLauncher(execPath: string, helperPath: string): string {
  for (const p of [execPath, helperPath]) {
    if (/["%\r\n]/.test(p)) throw new Error(`Cannot write the GIT_ASKPASS launcher: the path contains a character cmd cannot take literally: ${p}`);
  }
  return `@"${execPath}" "${helperPath}" %*\r\n`;
}
