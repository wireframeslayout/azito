import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertSafeBranch } from '../assertSafeGitArgs';
import type { CanonicalRepositoryIdentity } from '../resolveCanonicalRepositoryIdentity';
import type { CleanPushResult } from './types';
import { ASKPASS_USERNAME, type HubGitSupport } from '../HubGitSupport';

export class CleanPusher {
  constructor(private readonly hubGit: HubGitSupport) {}

  push(bundlePath: string, identity: CanonicalRepositoryIdentity, token: string, branch: string, seedDir?: string): CleanPushResult {
    assertSafeBranch(branch, 'branch');

    const nonce = crypto.randomBytes(8).toString('hex');
    const tmpDir = path.join(os.tmpdir(), `azito-clean-push-${nonce}`);

    try {
      fs.mkdirSync(tmpDir, { recursive: true });

      const env = this.cleanEnv();

      execFileSync('git', [
        ...this.hubGit.hooksPathArgs(),
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
          ...this.hubGit.hooksPathArgs(),
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
        ...this.hubGit.hooksPathArgs(),
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

      const pushUrl = this.embedUsername(identity.httpsUrl);
      execFileSync('git', [
        '-C', tmpDir,
        ...this.hubGit.hooksPathArgs(),
        'push', pushUrl,
        `refs/heads/${branch}:refs/heads/${branch}`,
      ], {
        encoding: 'utf-8',
        timeout: 120_000,
        env: {
          ...env,
          ...this.hubGit.askPassEnv(token),
          GIT_TERMINAL_PROMPT: '0',
        },
      });

      return { pushedSha };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  private embedUsername(httpsUrl: string): string {
    try {
      const url = new URL(httpsUrl);
      url.username = ASKPASS_USERNAME;
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
