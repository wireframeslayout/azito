import { describe, it, expect, vi } from 'vitest';
import { recoverInterruptedIsolationCleanup } from './recoverInterruptedIsolationCleanup';
import { ISOLATION_CLEANUP_PENDING_REPORT } from './Server';
import type { IServerRepository, ServerConfig } from './Server';

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: 'srv',
    type: 'agent',
    host: '1.2.3.4',
    agentPort: 4000,
    agentToken: 'tok',
    agentVersion: '1.0.0',
    sshHost: null,
    sshHostFingerprint: null,
    isolationIntent: true,
    isolationVerifiedAt: null,
    isolationReport: null,
    isolationCleanupReport: null,
    muxRuntime: 'system',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// Issue #29 review (final pass), Important finding 2: at hub startup, any
// row stranded at the pending marker (a process crash between
// updateIsolationIntent's atomic write and attemptIsolationCleanup's own
// settle) must be converted to an honest 'failed'/'interrupted' outcome —
// WITHOUT re-running the remote cleanup itself (see the function's doc
// comment for why re-attempting a remote side effect purely because the hub
// restarted is out of scope for this narrow pass).
//
// Review round (Important finding 4): the pending marker (and this
// recovery pass's own write) now live in isolationCleanupReport /
// updateIsolationCleanupReport — the cleanup-only column split out of
// isolationReport (now verification-only) — see Server.ts's doc comments.
describe('recoverInterruptedIsolationCleanup', () => {
  it('converts a row stuck at the pending marker to a failed/interrupted report', () => {
    const srv = makeServer({ isolationCleanupReport: ISOLATION_CLEANUP_PENDING_REPORT });
    const updateIsolationCleanupReport = vi.fn();
    const serverRepo = {
      findAll: vi.fn(() => [srv]),
      updateIsolationCleanupReport,
    } as unknown as IServerRepository;

    const recoveredCount = recoverInterruptedIsolationCleanup(serverRepo);

    expect(recoveredCount).toBe(1);
    expect(updateIsolationCleanupReport).toHaveBeenCalledWith(
      'srv',
      JSON.stringify({ kind: 'cleanup', cleanup: 'failed', reason: 'interrupted' }),
    );
  });

  it('does not touch a row whose report already settled at "done"', () => {
    const srv = makeServer({ isolationCleanupReport: JSON.stringify({ kind: 'cleanup', cleanup: 'done' }) });
    const updateIsolationCleanupReport = vi.fn();
    const serverRepo = {
      findAll: vi.fn(() => [srv]),
      updateIsolationCleanupReport,
    } as unknown as IServerRepository;

    const recoveredCount = recoverInterruptedIsolationCleanup(serverRepo);

    expect(recoveredCount).toBe(0);
    expect(updateIsolationCleanupReport).not.toHaveBeenCalled();
  });

  it('does not touch a row with no report at all (isolationCleanupReport === null)', () => {
    const srv = makeServer({ isolationCleanupReport: null });
    const updateIsolationCleanupReport = vi.fn();
    const serverRepo = {
      findAll: vi.fn(() => [srv]),
      updateIsolationCleanupReport,
    } as unknown as IServerRepository;

    const recoveredCount = recoverInterruptedIsolationCleanup(serverRepo);

    expect(recoveredCount).toBe(0);
    expect(updateIsolationCleanupReport).not.toHaveBeenCalled();
  });

  it('does not re-run the remote cleanup itself — only rewrites the cleanup report column', () => {
    const srv = makeServer({ isolationCleanupReport: ISOLATION_CLEANUP_PENDING_REPORT });
    const updateIsolationCleanupReport = vi.fn();
    const serverRepo = {
      findAll: vi.fn(() => [srv]),
      updateIsolationCleanupReport,
    } as unknown as IServerRepository;

    recoverInterruptedIsolationCleanup(serverRepo);

    // No other repository method (e.g. updateIsolationIntent, which would
    // imply a re-triggered transition) is ever called by this pass.
    expect(Object.keys(serverRepo)).not.toContain('updateIsolationIntent');
    expect(updateIsolationCleanupReport).toHaveBeenCalledTimes(1);
  });

  it('recovers multiple stranded rows in one pass and leaves non-pending rows alone', () => {
    const stuck1 = makeServer({ name: 'a', isolationCleanupReport: ISOLATION_CLEANUP_PENDING_REPORT });
    const stuck2 = makeServer({ name: 'b', isolationCleanupReport: ISOLATION_CLEANUP_PENDING_REPORT });
    const fine = makeServer({ name: 'c', isolationCleanupReport: JSON.stringify({ kind: 'cleanup', cleanup: 'done' }) });
    const updateIsolationCleanupReport = vi.fn();
    const serverRepo = {
      findAll: vi.fn(() => [stuck1, fine, stuck2]),
      updateIsolationCleanupReport,
    } as unknown as IServerRepository;

    const recoveredCount = recoverInterruptedIsolationCleanup(serverRepo);

    expect(recoveredCount).toBe(2);
    expect(updateIsolationCleanupReport).toHaveBeenCalledWith('a', expect.stringContaining('interrupted'));
    expect(updateIsolationCleanupReport).toHaveBeenCalledWith('b', expect.stringContaining('interrupted'));
    expect(updateIsolationCleanupReport).not.toHaveBeenCalledWith('c', expect.anything());
  });
});
