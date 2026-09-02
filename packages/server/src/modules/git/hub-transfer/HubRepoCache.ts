import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CanonicalRepositoryIdentity } from '../resolveCanonicalRepositoryIdentity';
import { computeRepoHash } from './repoHash';

export class HubRepoCache {
  private readonly cacheRoot: string;

  constructor(dataDir: string) {
    this.cacheRoot = path.join(dataDir, 'repo-cache');
    fs.mkdirSync(this.cacheRoot, { recursive: true });
  }

  ensureFetched(identity: CanonicalRepositoryIdentity, token: string, branch: string): string {
    const repoDir = this.repoCacheDir(identity);
    this.ensureBareRepo(repoDir, identity.httpsUrl);
    this.fetchWithAskPass(repoDir, token, branch);
    return this.resolveRef(repoDir, branch);
  }

  createBundle(identity: CanonicalRepositoryIdentity, branch: string, sinceCommit?: string): { bundlePath: string; headSha: string } {
    const repoDir = this.repoCacheDir(identity);
    const nonce = crypto.randomBytes(8).toString('hex');
    const bundlePath = path.join(os.tmpdir(), `azito-dist-${nonce}.bundle`);

    const refSpec = sinceCommit ? `${sinceCommit}..refs/heads/${branch}` : `refs/heads/${branch}`;
    const args = ['-C', repoDir, 'bundle', 'create', bundlePath, refSpec];
    try {
      execFileSync('git', args, { encoding: 'utf-8', timeout: 120_000, env: this.cleanEnv() });
    } catch (err) {
      try { fs.unlinkSync(bundlePath); } catch {}
      throw new Error(`git bundle create failed: ${err instanceof Error ? err.message : err}`);
    }

    const headSha = this.resolveRef(repoDir, branch);
    return { bundlePath, headSha };
  }

  getRepoCacheDir(identity: CanonicalRepositoryIdentity): string {
    return path.join(this.cacheRoot, computeRepoHash(identity));
  }

  private repoCacheDir(identity: CanonicalRepositoryIdentity): string {
    return this.getRepoCacheDir(identity);
  }

  private ensureBareRepo(repoDir: string, httpsUrl: string): void {
    const alreadyInitialized = fs.existsSync(path.join(repoDir, 'HEAD'));

    if (!alreadyInitialized) {
      fs.mkdirSync(repoDir, { recursive: true });
      execFileSync('git', ['init', '--bare', repoDir], {
        encoding: 'utf-8',
        timeout: 10_000,
        env: this.cleanEnv(),
      });
      const urlWithUser = this.embedUsername(httpsUrl);
      execFileSync('git', ['-C', repoDir, 'remote', 'add', 'origin', urlWithUser], {
        encoding: 'utf-8',
        timeout: 5_000,
        env: this.cleanEnv(),
      });
    }

    // Mirror the `origin` remote's `refs/heads/*` namespace into this bare
    // repo's own `refs/heads/*` (instead of git's default
    // `refs/remotes/origin/*`), because `resolveRef`/`createBundle` both
    // read `refs/heads/<branch>` directly. Applied unconditionally (even
    // when `alreadyInitialized`) so caches created before this fix — whose
    // `remote.origin.fetch` is still the default `refs/heads/*:refs/remotes/
    // origin/*` — self-heal on next use instead of staying permanently
    // broken. `git config` is idempotent to re-run.
    //
    // Deliberately `remote.origin.fetch` (fetch-side refspec), never
    // `git remote add --mirror` / `--mirror=fetch` — `--mirror` mirrors
    // *all* refs (`refs/*`, including tags and any other namespace) and,
    // more importantly, on the push side is the "force-push everything,
    // deleting anything absent locally" mode. Scoping to `refs/heads/*`
    // keeps the mirror limited to branches, matching what `resolveRef`/
    // `createBundle` actually need.
    execFileSync(
      'git',
      ['-C', repoDir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'],
      {
        encoding: 'utf-8',
        timeout: 5_000,
        env: this.cleanEnv(),
      },
    );
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

  private fetchWithAskPass(repoDir: string, token: string, branch: string): void {
    const askPassPath = this.writeAskPassScript(token);
    try {
      execFileSync('git', [
        '-C', repoDir,
        '-c', 'core.hooksPath=/dev/null',
        'fetch', 'origin',
        '--prune',
        '--atomic',
        `+refs/heads/${branch}:refs/heads/${branch}`,
      ], {
        encoding: 'utf-8',
        timeout: 120_000,
        env: {
          ...this.cleanEnv(),
          GIT_ASKPASS: askPassPath,
          GIT_TERMINAL_PROMPT: '0',
        },
      });
    } finally {
      try { fs.unlinkSync(askPassPath); } catch {}
    }
  }

  private writeAskPassScript(token: string): string {
    const nonce = crypto.randomBytes(8).toString('hex');
    const scriptPath = path.join(os.tmpdir(), `azito-askpass-${nonce}.sh`);
    fs.writeFileSync(scriptPath, `#!/bin/sh\necho '${token.replace(/'/g, "'\\''")}'`, { mode: 0o700 });
    return scriptPath;
  }

  private resolveRef(repoDir: string, branch: string): string {
    const sha = execFileSync('git', ['-C', repoDir, 'rev-parse', `refs/heads/${branch}`], {
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`Failed to resolve ref refs/heads/${branch}: ${sha}`);
    }
    return sha;
  }

  private cleanEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    };
  }
}
