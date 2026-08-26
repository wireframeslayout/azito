import * as crypto from 'crypto';
import type { IServerTransport } from '../../servers/transport/ServerTransport';
import { shellQuote } from '../../../shared/shellQuote';
import { assertSafeBranch } from '../assertSafeGitArgs';
import { DUMMY_ORIGIN_URL } from './types';

export class RemoteBundleOps {
  async verify(transport: IServerTransport, remoteBundlePath: string): Promise<boolean> {
    const r = await transport.exec(`git bundle verify ${shellQuote(remoteBundlePath)} 2>&1`, 30_000);
    return r.code === 0 && !r.stderr?.includes('fatal:');
  }

  async applyClone(transport: IServerTransport, remoteBundlePath: string, targetDir: string, branch: string): Promise<void> {
    assertSafeBranch(branch, 'branch');
    const r = await transport.exec(
      `git clone --branch ${shellQuote(branch)} ${shellQuote(remoteBundlePath)} ${shellQuote(targetDir)} 2>&1`,
      120_000,
    );
    if (r.code !== 0 || (r.stderr && r.stderr.includes('fatal:'))) {
      throw new Error(`git clone from bundle failed: ${r.stderr || r.stdout}`);
    }
    await this.setDummyOrigin(transport, targetDir);
  }

  async applyFetch(transport: IServerTransport, remoteBundlePath: string, targetDir: string, branch: string): Promise<void> {
    assertSafeBranch(branch, 'branch');
    const refspec = `${branch}:refs/remotes/origin/${branch}`;
    const r = await transport.exec(
      `cd ${shellQuote(targetDir)} && git fetch ${shellQuote(remoteBundlePath)} ${shellQuote(refspec)} 2>&1`,
      120_000,
    );
    if (r.code !== 0 || (r.stderr && r.stderr.includes('fatal:'))) {
      throw new Error(`git fetch from bundle failed: ${r.stderr || r.stdout}`);
    }
  }

  async createFromWorktree(transport: IServerTransport, worktreePath: string, branch: string, baseBranch: string | null): Promise<string> {
    assertSafeBranch(branch, 'branch');
    const nonce = crypto.randomBytes(8).toString('hex');
    const remoteBundlePath = `/tmp/azito-push-${nonce}.bundle`;

    const notClause = baseBranch
      ? `--not origin/${shellQuote(baseBranch)}`
      : '';
    const r = await transport.exec(
      `cd ${shellQuote(worktreePath)} && git bundle create ${shellQuote(remoteBundlePath)} ${shellQuote(branch)} ${notClause} 2>&1`,
      120_000,
    );
    if (r.code !== 0 || (r.stderr && r.stderr.includes('fatal:'))) {
      throw new Error(`git bundle create failed: ${r.stderr || r.stdout}`);
    }
    return remoteBundlePath;
  }

  async setDummyOrigin(transport: IServerTransport, targetDir: string): Promise<void> {
    await transport.exec(
      `cd ${shellQuote(targetDir)} && git remote set-url origin ${shellQuote(DUMMY_ORIGIN_URL)} 2>&1`,
      10_000,
    );
  }

  async getHeadSha(transport: IServerTransport, dir: string): Promise<string | null> {
    const r = await transport.exec(`cd ${shellQuote(dir)} && git rev-parse HEAD 2>/dev/null`, 10_000);
    const sha = r.stdout?.trim();
    return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  async repoExists(transport: IServerTransport, dir: string): Promise<boolean> {
    const r = await transport.exec(`test -d ${shellQuote(dir + '/.git')} && echo yes || echo no`, 5_000);
    return r.stdout?.trim() === 'yes';
  }

  async cleanup(transport: IServerTransport, remotePath: string): Promise<void> {
    await transport.exec(`rm -f ${shellQuote(remotePath)}`, 5_000);
  }
}
