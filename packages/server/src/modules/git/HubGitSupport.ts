import * as fs from 'fs';
import * as path from 'path';
import type { HostEnv } from '../../shared/os/hostEnv';
import type { SecretFileGuard } from '../../shared/os/secretFileGuardTypes';
import { shellQuote } from '../../shared/shellQuote';
import { ASKPASS_HELPER_SOURCE, ASKPASS_TOKEN_ENV, ASKPASS_USERNAME_ENV } from './askPassHelperSource';

/** The non-secret username the hub puts in a clone / push URL (the token is only the password). */
export const ASKPASS_USERNAME = 'x-access-token';

export type HubGitHostEnv = Pick<HostEnv, 'platform' | 'tmpDir' | 'execPath'>;

interface SupportFiles {
  launcherPath: string;
  hooksDir: string;
}

/** Directories to remove when the process exits, so each hub start does not leave its support directory behind. */
const liveDirs = new Set<string>();
let exitHookInstalled = false;

function removeOnExit(dir: string): void {
  liveDirs.add(dir);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const d of liveDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup at exit */ }
    }
  });
}

/**
 * What the git commands that run on the HUB's own machine need that differs by OS:
 *  - `GIT_ASKPASS`: git runs the whole value as ONE executable, so it is a small launcher (Unix: sh, Windows: `.cmd`) that
 *    runs the shared Node helper with `HostEnv.execPath`. Neither file contains the token; it reaches the helper through the
 *    environment of the git child (`askPassEnv`).
 *  - `core.hooksPath`: an empty directory we own, instead of `/dev/null` (which Windows does not have).
 *
 * The files are created once per process, on first use, in a fresh directory under `HostEnv.tmpDir` that only the
 * current user can enter (`SecretFileGuard.ensureProtectedDir`) — another user must not be able to swap the launcher,
 * because the launcher is what receives the token. The directory is removed when the process exits.
 */
export class HubGitSupport {
  private files: SupportFiles | null = null;

  constructor(
    private readonly hostEnv: HubGitHostEnv,
    private readonly guard: SecretFileGuard,
  ) {}

  /** Environment entries for a git child that may ask for credentials. Spread over the base env of the git call. */
  askPassEnv(token: string): NodeJS.ProcessEnv {
    if (token === '') throw new Error('askPassEnv: token must not be empty');
    return {
      GIT_ASKPASS: this.ensureFiles().launcherPath,
      [ASKPASS_TOKEN_ENV]: token,
      [ASKPASS_USERNAME_ENV]: ASKPASS_USERNAME,
    };
  }

  /** `-c core.hooksPath=<managed empty dir>`: git never runs a hook from the repository being operated on. */
  hooksPathArgs(): string[] {
    return ['-c', `core.hooksPath=${this.ensureFiles().hooksDir}`];
  }

  private ensureFiles(): SupportFiles {
    if (this.files) return this.files;
    const dir = fs.mkdtempSync(path.join(this.hostEnv.tmpDir, 'azito-git-'));
    removeOnExit(dir);
    this.guard.ensureProtectedDir(dir);

    const helperPath = path.join(dir, 'askpass.cjs');
    fs.writeFileSync(helperPath, ASKPASS_HELPER_SOURCE);

    const isWindows = this.hostEnv.platform === 'win32';
    const launcherPath = path.join(dir, isWindows ? 'askpass.cmd' : 'askpass.sh');
    if (isWindows) {
      fs.writeFileSync(launcherPath, windowsLauncher(this.hostEnv.execPath, helperPath));
    } else {
      fs.writeFileSync(launcherPath, `#!/bin/sh\nexec ${shellQuote(this.hostEnv.execPath)} ${shellQuote(helperPath)} "$@"\n`, { mode: 0o700 });
    }

    const hooksDir = path.join(dir, 'hooks');
    fs.mkdirSync(hooksDir);
    this.files = { launcherPath, hooksDir };
    return this.files;
  }
}

/** `%` would be expanded by cmd inside a batch file, and `"` cannot be in a Windows path; refuse rather than write a wrong launcher. */
function windowsLauncher(execPath: string, helperPath: string): string {
  for (const p of [execPath, helperPath]) {
    if (/["%\r\n]/.test(p)) throw new Error(`Cannot write the GIT_ASKPASS launcher: the path contains a character cmd cannot take literally: ${p}`);
  }
  return `@"${execPath}" "${helperPath}" %*\r\n`;
}
