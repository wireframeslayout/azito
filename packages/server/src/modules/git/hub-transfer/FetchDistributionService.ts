import * as crypto from 'crypto';
import * as fs from 'fs';
import type { SftpService } from '../../servers/ssh/SftpService';
import type { HubRepoCache } from './HubRepoCache';
import type { RemoteBundleOps } from './RemoteBundleOps';
import type { IDistributionStateRepository, FetchDistributionParams, FetchDistributionResult } from './types';

export class FetchDistributionService {
  constructor(
    private hubRepoCache: HubRepoCache,
    private remoteBundleOps: RemoteBundleOps,
    private sftpService: SftpService,
    private distributionStateRepo: IDistributionStateRepository,
  ) {}

  async distribute(params: FetchDistributionParams): Promise<FetchDistributionResult> {
    const { server, transport, repoIdentity, token, branch, workingDir } = params;
    const sshHost = server.sshHost;
    if (!sshHost) {
      return { status: 'failed', error: 'Server has no sshHost configured for SFTP transfer' };
    }

    try {
      const headSha = this.hubRepoCache.ensureFetched(repoIdentity, token, branch);

      const { repositoryId } = params;
      const existing = this.distributionStateRepo.findByServerAndRepo(server.name, repositoryId);

      if (existing && existing.lastDistributedSha === headSha) {
        return { status: 'already_current', sha: headSha };
      }

      const sinceCommit = existing?.lastDistributedSha;
      let bundleResult = sinceCommit
        ? this.tryCreateBundle(repoIdentity, branch, sinceCommit)
        : null;

      let bundleType: 'full' | 'incremental' = sinceCommit && bundleResult ? 'incremental' : 'full';
      if (!bundleResult) {
        bundleResult = this.hubRepoCache.createBundle(repoIdentity, branch);
        bundleType = 'full';
      }

      const nonce = crypto.randomBytes(8).toString('hex');
      const remoteTmpPath = `/tmp/azito-dist-${nonce}.bundle`;

      try {
        await this.sftpService.upload(sshHost, bundleResult.bundlePath, remoteTmpPath);

        const verified = await this.remoteBundleOps.verify(transport, remoteTmpPath);
        if (!verified && bundleType === 'incremental') {
          await this.remoteBundleOps.cleanup(transport, remoteTmpPath);
          fs.unlinkSync(bundleResult.bundlePath);
          bundleResult = this.hubRepoCache.createBundle(repoIdentity, branch);
          bundleType = 'full';
          await this.sftpService.upload(sshHost, bundleResult.bundlePath, remoteTmpPath);
          const reVerified = await this.remoteBundleOps.verify(transport, remoteTmpPath);
          if (!reVerified) {
            throw new Error('Full bundle verification failed after incremental fallback');
          }
        } else if (!verified) {
          throw new Error('Bundle verification failed on remote');
        }

        const repoExists = await this.remoteBundleOps.repoExists(transport, workingDir);
        if (repoExists) {
          await this.remoteBundleOps.applyFetch(transport, remoteTmpPath, workingDir, branch);
        } else {
          await this.remoteBundleOps.applyClone(transport, remoteTmpPath, workingDir, branch);
        }

        await this.remoteBundleOps.setDummyOrigin(transport, workingDir);
        await this.remoteBundleOps.cleanup(transport, remoteTmpPath);

        this.distributionStateRepo.upsert(server.name, repositoryId, headSha, bundleType);

        return { status: 'distributed', sha: headSha, bundleType };
      } finally {
        try { fs.unlinkSync(bundleResult.bundlePath); } catch {}
      }
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }

  private tryCreateBundle(
    identity: Parameters<HubRepoCache['createBundle']>[0],
    branch: string,
    sinceCommit: string,
  ): ReturnType<HubRepoCache['createBundle']> | null {
    try {
      return this.hubRepoCache.createBundle(identity, branch, sinceCommit);
    } catch {
      return null;
    }
  }
}
