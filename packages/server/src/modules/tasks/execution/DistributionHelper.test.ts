import { describe, it, expect } from 'vitest';
import { resolveExecutionRepositoryEntry } from './DistributionHelper';
import type { ServerConfig } from '../../servers/Server';
import type { ProjectDetail, ProjectRepository } from '../../projects/Project';
import type { ProjectServer } from '../../projects/ProjectServer';

// Issue #87 13th-round review, Important finding: the distribution target
// (`projectServer.distributionRepositoryId`) and the repository push/PR/
// notarization actually use used to disagree — this function is the single
// resolution point both `performDistribution` (via `isDistributionRequired`)
// and every downstream targeting decision (PhaseLoopRunner's pushing probe/
// notary, ExecuteTaskUseCase's final-git-info/isPushCompleted paths,
// ExecutionManifest's approval fingerprint) must now share.

const repoA: ProjectRepository = { id: 1, name: 'A', url: 'https://github.com/acme/repo-a.git', provider: 'github', owner: 'acme', repoName: 'repo-a', hasToken: true };
const repoB: ProjectRepository = { id: 2, name: 'B', url: 'https://github.com/acme/repo-b.git', provider: 'github', owner: 'acme', repoName: 'repo-b', hasToken: true };

function makeProject(repositories: ProjectRepository[]): Pick<ProjectDetail, 'repositories'> {
  return { repositories };
}

function makeProjectServer(overrides: Partial<Pick<ProjectServer, 'distributeCode' | 'distributionRepositoryId'>>): Pick<ProjectServer, 'distributeCode' | 'distributionRepositoryId'> {
  return { distributeCode: false, distributionRepositoryId: null, ...overrides };
}

function makeAgentServer(overrides: Partial<Pick<ServerConfig, 'type' | 'isolationIntent'>> = {}): Pick<ServerConfig, 'type' | 'isolationIntent'> {
  return { type: 'agent', isolationIntent: false, ...overrides };
}

describe('resolveExecutionRepositoryEntry', () => {
  it('resolves the distributionRepositoryId target (repo B) when distribute_code is on for this project/server', () => {
    const result = resolveExecutionRepositoryEntry(
      makeAgentServer(),
      makeProjectServer({ distributeCode: true, distributionRepositoryId: repoB.id }),
      makeProject([repoA, repoB]),
    );
    expect(result?.id).toBe(repoB.id);
  });

  it('resolves the distributionRepositoryId target (repo B) when the server carries isolationIntent, even with distribute_code off', () => {
    const result = resolveExecutionRepositoryEntry(
      makeAgentServer({ isolationIntent: true }),
      makeProjectServer({ distributeCode: false, distributionRepositoryId: repoB.id }),
      makeProject([repoA, repoB]),
    );
    expect(result?.id).toBe(repoB.id);
  });

  it('falls back to repositories[0] (A) when distribution is not required for this project/server (no distributeCode, no isolationIntent)', () => {
    const result = resolveExecutionRepositoryEntry(
      makeAgentServer(),
      makeProjectServer({ distributeCode: false, distributionRepositoryId: repoB.id }),
      makeProject([repoA, repoB]),
    );
    expect(result?.id).toBe(repoA.id);
  });

  it('falls back to repositories[0] (A) for a local server, even when distributionRepositoryId is set (local is never a distribution target)', () => {
    const result = resolveExecutionRepositoryEntry(
      { type: 'local', isolationIntent: false },
      makeProjectServer({ distributeCode: true, distributionRepositoryId: repoB.id }),
      makeProject([repoA, repoB]),
    );
    expect(result?.id).toBe(repoA.id);
  });

  // Issue #87 14th-round review, Important finding: these two cases used to
  // fall back to repositories[0] (A) even though distribution IS required —
  // reintroducing the exact push/PR/notary-target mismatch this function
  // exists to prevent. Both must now return null instead.

  it('returns null (does NOT fall back to repositories[0]) when distribution is active but no distributionRepositoryId is configured', () => {
    const result = resolveExecutionRepositoryEntry(
      makeAgentServer({ isolationIntent: true }),
      makeProjectServer({ distributeCode: false, distributionRepositoryId: null }),
      makeProject([repoA, repoB]),
    );
    expect(result).toBeNull();
  });

  it('returns null (does NOT fall back to repositories[0]) when distribution is active but the configured distributionRepositoryId no longer exists on the project', () => {
    const result = resolveExecutionRepositoryEntry(
      makeAgentServer({ isolationIntent: true }),
      makeProjectServer({ distributeCode: false, distributionRepositoryId: 999 }),
      makeProject([repoA, repoB]),
    );
    expect(result).toBeNull();
  });

  it('returns null when distribute_code is on (no isolationIntent) but no distributionRepositoryId is configured', () => {
    const result = resolveExecutionRepositoryEntry(
      makeAgentServer(),
      makeProjectServer({ distributeCode: true, distributionRepositoryId: null }),
      makeProject([repoA, repoB]),
    );
    expect(result).toBeNull();
  });

  it('returns null when the project has no registered repository at all', () => {
    const result = resolveExecutionRepositoryEntry(
      makeAgentServer(),
      makeProjectServer({}),
      makeProject([]),
    );
    expect(result).toBeNull();
  });

  it('returns null when server is null (no resolvable server) and there is no repository to fall back to', () => {
    const result = resolveExecutionRepositoryEntry(null, makeProjectServer({}), makeProject([]));
    expect(result).toBeNull();
  });

  it('returns null when project is null', () => {
    const result = resolveExecutionRepositoryEntry(makeAgentServer(), makeProjectServer({}), null);
    expect(result).toBeNull();
  });

  it('returns null when projectServer is null and distribution is not otherwise required', () => {
    const result = resolveExecutionRepositoryEntry(makeAgentServer(), null, makeProject([]));
    expect(result).toBeNull();
  });
});
