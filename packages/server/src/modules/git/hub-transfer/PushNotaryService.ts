import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SftpService } from '../../servers/ssh/SftpService';
import type { GitProviderService } from '../providers/GitProviderService';
import type { RemoteBundleOps } from './RemoteBundleOps';
import type { CleanPusher } from './CleanPusher';
import type { HubRepoCache } from './HubRepoCache';
import { resolveCanonicalRepositoryIdentity, type CanonicalRepositoryIdentity } from '../resolveCanonicalRepositoryIdentity';
import type { PushNotaryParams, PushNotaryResult } from './types';

export class PushNotaryService {
  constructor(
    private remoteBundleOps: RemoteBundleOps,
    private sftpService: SftpService,
    private cleanPusher: CleanPusher,
    private gitProvider: GitProviderService,
    private hubRepoCache: HubRepoCache,
  ) {}

  async notarize(params: PushNotaryParams): Promise<PushNotaryResult> {
    const { server, transport, worktreePath, branch, baseBranch, repo, token } = params;
    const sshHost = server.sshHost;
    if (!sshHost) {
      return { status: 'failed', error: 'Server has no sshHost configured for SFTP transfer' };
    }

    if (!token) {
      return { status: 'failed', error: 'No push credential was resolved for hub push notarization' };
    }

    const identity = resolveCanonicalRepositoryIdentity(repo);
    if (!identity.ok) {
      return { status: 'failed', error: `Repository identity resolution failed: ${identity.reason}` };
    }

    try {
      const workerHeadSha = await this.remoteBundleOps.getHeadSha(transport, worktreePath);
      if (!workerHeadSha) {
        return { status: 'failed', error: 'Could not read HEAD SHA from worker worktree' };
      }

      const remoteSha = await this.gitProvider.getBranchHeadSha(repo, branch);
      if (remoteSha === workerHeadSha) {
        return { status: 'already_up_to_date', sha: workerHeadSha };
      }

      // #124 Bug 1: when baseBranch is set, ensure the hub's repo-cache has
      // the base branch objects so CleanPusher can seed from it.
      let seedDir: string | undefined;
      if (baseBranch) {
        try {
          this.hubRepoCache.ensureFetched(identity.identity, token, baseBranch);
          seedDir = this.hubRepoCache.getRepoCacheDir(identity.identity);
        } catch {
          // Cache fetch failed (hub offline, token invalid for this branch, etc.).
          // Proceed without seed — will fall back to full bundle if prerequisite error occurs.
        }
      }

      const pushResult = await this.attemptPush(params, identity.identity, token, branch, baseBranch, seedDir);

      // #124 Bug 4: SHA verification with retry for remote propagation lag.
      // GitHub's API can take 1-3s to reflect a just-pushed branch.
      const verifiedSha = await this.verifyPushWithRetry(repo, branch, pushResult.pushedSha);
      if (!verifiedSha) {
        return {
          status: 'failed',
          error: `Push completed (SHA: ${pushResult.pushedSha}) but remote verification timed out after 3 attempts`
            + ` — branch may exist on remote, verify with: git ls-remote --heads origin ${branch}`,
        };
      }

      return { status: 'notarized', sha: pushResult.pushedSha };
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async attemptPush(
    params: PushNotaryParams,
    identity: CanonicalRepositoryIdentity,
    token: string,
    branch: string,
    baseBranch: string | null,
    seedDir: string | undefined,
  ): Promise<{ pushedSha: string }> {
    const { server, transport, worktreePath } = params;
    const sshHost = server.sshHost!;

    const remoteBundlePath = await this.remoteBundleOps.createFromWorktree(transport, worktreePath, branch, baseBranch);
    const localBundlePath = await this.downloadBundle(sshHost, remoteBundlePath, transport);

    try {
      return this.cleanPusher.push(localBundlePath, identity, token, branch, seedDir);
    } catch (err) {
      // #124 Bug 1: fall back to full bundle ONLY on prerequisite errors.
      // Prerequisite errors occur when the incremental bundle references
      // commits the seed repo doesn't have. Other errors (authentication,
      // network) should NOT be retried with a full bundle — that would
      // hide the real cause.
      // Matches: "error: Repository lacks these prerequisite commits:"
      if (baseBranch && this.isPrerequisiteError(err)) {
        return this.retryWithFullBundle(transport, worktreePath, branch, sshHost, identity, token);
      }
      throw err;
    } finally {
      try { fs.unlinkSync(localBundlePath); } catch {}
    }
  }

  private async retryWithFullBundle(
    transport: PushNotaryParams['transport'],
    worktreePath: string,
    branch: string,
    sshHost: string,
    identity: CanonicalRepositoryIdentity,
    token: string,
  ): Promise<{ pushedSha: string }> {
    const remoteBundlePath = await this.remoteBundleOps.createFromWorktree(transport, worktreePath, branch, null);
    const localBundlePath = await this.downloadBundle(sshHost, remoteBundlePath, transport);
    try {
      return this.cleanPusher.push(localBundlePath, identity, token, branch);
    } finally {
      try { fs.unlinkSync(localBundlePath); } catch {}
    }
  }

  private async downloadBundle(sshHost: string, remoteBundlePath: string, transport: PushNotaryParams['transport']): Promise<string> {
    const nonce = crypto.randomBytes(8).toString('hex');
    const localBundlePath = path.join(os.tmpdir(), `azito-push-recv-${nonce}.bundle`);
    await this.sftpService.download(sshHost, remoteBundlePath, localBundlePath);
    await this.remoteBundleOps.cleanup(transport, remoteBundlePath);
    return localBundlePath;
  }

  // #124 Bug 1: only prerequisite errors justify falling back to a full
  // bundle. This matches git's error output:
  //   "error: Repository lacks these prerequisite commits:"
  private isPrerequisiteError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes('prerequisite commits');
  }

  // #124 Bug 4: retry SHA verification with exponential backoff.
  // NOT applied to the pre-push `already_up_to_date` check (null is normal there).
  private async verifyPushWithRetry(
    repo: PushNotaryParams['repo'],
    branch: string,
    expectedSha: string,
    maxAttempts = 3,
  ): Promise<string | null> {
    const delays = [1000, 2000, 4000];
    for (let i = 0; i < maxAttempts; i++) {
      const sha = await this.gitProvider.getBranchHeadSha(repo, branch);
      if (sha === expectedSha) return sha;
      if (i < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, delays[i]));
      }
    }
    return null;
  }
}
