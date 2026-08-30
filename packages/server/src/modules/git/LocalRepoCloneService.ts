import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { CanonicalRepositoryIdentity } from './resolveCanonicalRepositoryIdentity';
import { redactGitUrlCredentials } from './redactGitUrlCredentials';

const execFileAsync = promisify(execFile);

/** Thrown when the requested clone target already exists and is not an empty directory — the caller must never overwrite pre-existing content. */
export class LocalCloneTargetNotEmptyError extends Error {
  constructor(targetDir: string) {
    super(`Target directory already exists and is not empty: ${targetDir}`);
    this.name = 'LocalCloneTargetNotEmptyError';
  }
}

/**
 * Clones a project repository directly into a directory on the HUB's own
 * local filesystem. Only meaningful for a `local`-type project server (the
 * hub itself) — every other server type is provisioned via the existing
 * hub-代行配信 path (`FetchDistributionService`/`HubRepoCache`), which
 * `local` is structurally excluded from (see ExecuteTaskUseCase's
 * distribution gate). Callers (projects/routes.ts) must reject non-`local`
 * servers before ever reaching this service.
 *
 * Credential handling mirrors `HubRepoCache`'s existing `GIT_ASKPASS`
 * pattern: the token is written to a mode-0700 temp script that just echoes
 * it back, never passed as a literal CLI argument or embedded in the clone
 * URL (only the non-secret `x-access-token` username goes in the URL), and
 * the script is removed in a `finally` block. Any error is stripped of
 * embedded URL credentials before it is thrown (Issue #87 review, "クローン
 * が壊れた設定を作る" finding 4) — this codebase's `redactGitUrlCredentials`.
 *
 * `clone()` runs `git clone` asynchronously (`execFile`, promisified —
 * never `execFileSync`): AZITO is a single-process hub, and a synchronous
 * clone would block the Node event loop (HTTP/WS/activity-detection/timers)
 * for up to the full 300s timeout whenever the remote is slow or
 * unreachable (review finding, "クローンがイベントループを最大5分ブロッ
 * クする"). The 300s timeout and error/redaction semantics are unchanged
 * from the previous sync implementation.
 */
export class LocalRepoCloneService {
  async clone(identity: CanonicalRepositoryIdentity, token: string | null, branch: string, targetDir: string): Promise<void> {
    this.assertTargetEmpty(targetDir);
    fs.mkdirSync(targetDir, { recursive: true });

    const cloneUrl = token ? this.embedAskPassUsername(identity.httpsUrl) : identity.httpsUrl;
    const askPassPath = token ? this.writeAskPassScript(token) : null;
    try {
      await execFileAsync('git', [
        '-c', 'core.hooksPath=/dev/null',
        'clone', '--branch', branch, '--single-branch', cloneUrl, targetDir,
      ], {
        encoding: 'utf-8',
        timeout: 300_000,
        env: {
          ...this.cleanEnv(),
          ...(askPassPath ? { GIT_ASKPASS: askPassPath } : {}),
        },
      });
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      throw new Error(`git clone failed: ${this.redactMessage(rawMessage, [identity.httpsUrl, cloneUrl])}`);
    } finally {
      if (askPassPath) { try { fs.unlinkSync(askPassPath); } catch { /* best-effort cleanup */ } }
    }
  }

  private assertTargetEmpty(targetDir: string): void {
    if (!fs.existsSync(targetDir)) return;
    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory() || fs.readdirSync(targetDir).length > 0) {
      throw new LocalCloneTargetNotEmptyError(targetDir);
    }
  }

  /** Same non-secret `x-access-token` username convention as HubRepoCache.embedUsername — the password/token itself never goes in the URL. */
  private embedAskPassUsername(httpsUrl: string): string {
    try {
      const url = new URL(httpsUrl);
      url.username = 'x-access-token';
      return url.toString();
    } catch {
      return httpsUrl;
    }
  }

  private writeAskPassScript(token: string): string {
    const nonce = crypto.randomBytes(8).toString('hex');
    const scriptPath = path.join(os.tmpdir(), `azito-clone-askpass-${nonce}.sh`);
    fs.writeFileSync(scriptPath, `#!/bin/sh\necho '${token.replace(/'/g, "'\\''")}'`, { mode: 0o700 });
    return scriptPath;
  }

  /** Replaces every URL this call could have embedded a credential in with its redacted form, so a raw git error can never leak the token even indirectly (e.g. an `x-access-token@host` echoed back by git). */
  private redactMessage(message: string, urls: string[]): string {
    let out = message;
    for (const url of urls) {
      if (url && out.includes(url)) out = out.split(url).join(redactGitUrlCredentials(url));
    }
    return out;
  }

  private cleanEnv(): NodeJS.ProcessEnv {
    return { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  }
}
