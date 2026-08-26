import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertSafeBranch } from '../assertSafeGitArgs';
import type { CanonicalRepositoryIdentity } from '../resolveCanonicalRepositoryIdentity';
import type { CleanPushResult } from './types';

export class CleanPusher {
  push(bundlePath: string, identity: CanonicalRepositoryIdentity, token: string, branch: string): CleanPushResult {
    assertSafeBranch(branch, 'branch');

    const nonce = crypto.randomBytes(8).toString('hex');
    const tmpDir = path.join(os.tmpdir(), `azito-clean-push-${nonce}`);
    let askPassPath: string | null = null;

    try {
      fs.mkdirSync(tmpDir, { recursive: true });

      const env = this.cleanEnv();

      execFileSync('git', ['init', '--bare', tmpDir], {
        encoding: 'utf-8',
        timeout: 10_000,
        env,
      });

      const refSpec = `refs/heads/${branch}:refs/heads/${branch}`;
      execFileSync('git', ['-C', tmpDir, 'fetch', bundlePath, refSpec], {
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
      const pushUrl = identity.httpsUrl;
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

  private cleanEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TEMPLATE_DIR: '',
      GIT_TERMINAL_PROMPT: '0',
    };
  }
}
