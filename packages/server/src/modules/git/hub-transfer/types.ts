import type { CanonicalRepositoryIdentity } from '../resolveCanonicalRepositoryIdentity';
import type { ServerConfig } from '../../servers/Server';
import type { IServerTransport } from '../../servers/transport/ServerTransport';
import type { ProjectRepositoryWithToken } from '../../projects/Project';

// ── Distribution state (Phase 1) ──

export interface DistributionState {
  id: number;
  serverName: string;
  repositoryId: number;
  lastDistributedSha: string;
  bundleType: 'full' | 'incremental';
  distributedAt: string;
}

export interface IDistributionStateRepository {
  findByServerAndRepo(serverName: string, repositoryId: number): DistributionState | null;
  upsert(serverName: string, repositoryId: number, sha: string, bundleType: 'full' | 'incremental'): void;
  deleteByServer(serverName: string): void;
}

// ── Fetch distribution (Phase 1) ──

export interface FetchDistributionParams {
  server: ServerConfig;
  transport: IServerTransport;
  repoIdentity: CanonicalRepositoryIdentity;
  token: string;
  branch: string;
  workingDir: string;
  repositoryId: number;
}

export interface FetchDistributionResult {
  status: 'distributed' | 'already_current' | 'failed';
  sha?: string;
  bundleType?: 'full' | 'incremental';
  error?: string;
}

// ── Push notarization (Phase 2) ──

export interface PushNotaryParams {
  taskId: number;
  unitId: number;
  server: ServerConfig;
  transport: IServerTransport;
  worktreePath: string;
  branch: string;
  baseBranch: string | null;
  repo: ProjectRepositoryWithToken;
}

export interface PushNotaryResult {
  status: 'notarized' | 'already_up_to_date' | 'failed';
  sha?: string;
  error?: string;
}

export interface CleanPushResult {
  pushedSha: string;
}

// ── Shared ──

export const DUMMY_ORIGIN_URL = 'https://azito-isolated-no-direct-access.invalid/repo.git';
