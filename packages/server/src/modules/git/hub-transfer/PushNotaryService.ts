import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SftpService } from '../../servers/ssh/SftpService';
import type { GitProviderService } from '../providers/GitProviderService';
import type { RemoteBundleOps } from './RemoteBundleOps';
import type { CleanPusher } from './CleanPusher';
import { resolveCanonicalRepositoryIdentity } from '../resolveCanonicalRepositoryIdentity';
import type { PushNotaryParams, PushNotaryResult } from './types';

export class PushNotaryService {
  constructor(
    private remoteBundleOps: RemoteBundleOps,
    private sftpService: SftpService,
    private cleanPusher: CleanPusher,
    private gitProvider: GitProviderService,
  ) {}

  async notarize(params: PushNotaryParams): Promise<PushNotaryResult> {
    const { server, transport, worktreePath, branch, baseBranch, repo } = params;
    const sshHost = server.sshHost;
    if (!sshHost) {
      return { status: 'failed', error: 'Server has no sshHost configured for SFTP transfer' };
    }

    if (!repo.token) {
      return { status: 'failed', error: 'No push credential (project_repositories.token) configured' };
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

      const remoteBundlePath = await this.remoteBundleOps.createFromWorktree(transport, worktreePath, branch, baseBranch);

      const nonce = crypto.randomBytes(8).toString('hex');
      const localBundlePath = path.join(os.tmpdir(), `azito-push-recv-${nonce}.bundle`);

      try {
        await this.sftpService.download(sshHost, remoteBundlePath, localBundlePath);
        await this.remoteBundleOps.cleanup(transport, remoteBundlePath);

        const pushResult = this.cleanPusher.push(localBundlePath, identity.identity, repo.token, branch);

        const verifiedSha = await this.gitProvider.getBranchHeadSha(repo, branch);
        if (verifiedSha !== pushResult.pushedSha) {
          return { status: 'failed', error: `Push verification failed: expected ${pushResult.pushedSha}, got ${verifiedSha}` };
        }

        return { status: 'notarized', sha: pushResult.pushedSha };
      } finally {
        try { fs.unlinkSync(localBundlePath); } catch {}
      }
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }
}
