import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertSafeBranch } from '../assertSafeGitArgs';
import type { CanonicalRepositoryIdentity } from '../resolveCanonicalRepositoryIdentity';
import type { CleanPushResult } from './types';

export class CleanPusher {
  push(bundlePath: string, identity: CanonicalRepositoryIdentity, token: string, branch: string, seedDir?: string): CleanPushResult {
    assertSafeBranch(branch, 'branch');

    const nonce = crypto.randomBytes(8).toString('hex');
    const tmpDir = path.join(os.tmpdir(), `azito-clean-push-${nonce}`);
    let askPassPath: string | null = null;

    try {
      fs.mkdirSync(tmpDir, { recursive: true });

      const env = this.cleanEnv();

      execFileSync('git', [
        '-c', 'core.hooksPath=/dev/null',
        'init', '--bare', tmpDir,
      ], {
        encoding: 'utf-8',
        timeout: 10_000,
        env,
      });

      // #124 Bug 1: seed prerequisites from hub repo-cache so incremental
      // bundles (created with `--not origin/<baseBranch>`) can be applied.
      // Without this, the empty bare repo lacks the prerequisite commits the
      // bundle references and `git fetch <bundle>` always fails.
      if (seedDir && fs.existsSync(seedDir)) {
        execFileSync('git', [
          '-C', tmpDir,
          '-c', 'core.hooksPath=/dev/null',
          'fetch', seedDir, '+refs/heads/*:refs/heads/*',
        ], {
          encoding: 'utf-8',
          timeout: 60_000,
          env,
        });
      }

      // The bundle originates from an untrusted server-side worktree, so
      // reject malformed/oversized objects instead of trusting git's
      // fsck-disabled default before they reach the hub's bare repo.
      const refSpec = `refs/heads/${branch}:refs/heads/${branch}`;
      execFileSync('git', [
        '-C', tmpDir,
        '-c', 'fetch.fsckObjects=true',
        '-c', 'transfer.fsckObjects=true',
        '-c', 'core.hooksPath=/dev/null',
        'fetch', bundlePath, refSpec,
      ], {
        encoding: 'utf-8',
        timeout: 60_000,
        env,
      });

      const pushedSha = execFileSync('git', ['-C', tmpDir, 'rev-parse', `refs/heads/${branch}`], {
        encoding: 'utf-8',
        timeout: 5_000,
        env,
      }).trim();

      askPassPath = this.writeAskPassScript(token);
      const pushUrl = this.embedUsername(identity.httpsUrl);
      execFileSync('git', [
        '-C', tmpDir,
        '-c', 'core.hooksPath=/dev/null',
        'push', pushUrl,
        `refs/heads/${branch}:refs/heads/${branch}`,
      ], {
        encoding: 'utf-8',
        timeout: 120_000,
        env: {
          ...env,
          GIT_ASKPASS: askPassPath,
          GIT_TERMINAL_PROMPT: '0',
        },
      });

      return { pushedSha };
    } finally {
      if (askPassPath) try { fs.unlinkSync(askPassPath); } catch {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  private writeAskPassScript(token: string): string {
    const nonce = crypto.randomBytes(8).toString('hex');
    const scriptPath = path.join(os.tmpdir(), `azito-askpass-push-${nonce}.sh`);
    fs.writeFileSync(scriptPath, `#!/bin/sh\necho '${token.replace(/'/g, "'\\''")}'`, { mode: 0o700 });
    return scriptPath;
  }

  private embedUsername(httpsUrl: string): string {
    try {
      const url = new URL(httpsUrl);
      url.username = 'x-access-token';
      return url.toString();
    } catch {
      return httpsUrl;
    }
  }

  private cleanEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TEMPLATE_DIR: '',
      GIT_TERMINAL_PROMPT: '0',
    };
  }
}
