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
describe('recoverInterruptedIsolationCleanup', () => {
  it('converts a row stuck at the pending marker to a failed/interrupted report', () => {
    const srv = makeServer({ isolationReport: ISOLATION_CLEANUP_PENDING_REPORT });
    const updateIsolationReport = vi.fn();
    const serverRepo = {
      findAll: vi.fn(() => [srv]),
      updateIsolationReport,
    } as unknown as IServerRepository;

    const recoveredCount = recoverInterruptedIsolationCleanup(serverRepo);

    expect(recoveredCount).toBe(1);
    expect(updateIsolationReport).toHaveBeenCalledWith(
      'srv',
      JSON.stringify({ kind: 'cleanup', cleanup: 'failed', reason: 'interrupted' }),
    );
  });

  it('does not touch a row whose report already settled at "done"', () => {
    const srv = makeServer({ isolationReport: JSON.stringify({ kind: 'cleanup', cleanup: 'done' }) });
    const updateIsolationReport = vi.fn();
    const serverRepo = {
      findAll: vi.fn(() => [srv]),
      updateIsolationReport,
    } as unknown as IServerRepository;

    const recoveredCount = recoverInterruptedIsolationCleanup(serverRepo);

    expect(recoveredCount).toBe(0);
    expect(updateIsolationReport).not.toHaveBeenCalled();
  });

  it('does not touch a row with no report at all (isolationReport === null)', () => {
    const srv = makeServer({ isolationReport: null });
    const updateIsolationReport = vi.fn();
    const serverRepo = {
      findAll: vi.fn(() => [srv]),
      updateIsolationReport,
    } as unknown as IServerRepository;

    const recoveredCount = recoverInterruptedIsolationCleanup(serverRepo);

    expect(recoveredCount).toBe(0);
    expect(updateIsolationReport).not.toHaveBeenCalled();
  });

  it('does not re-run the remote cleanup itself — only rewrites the report column', () => {
    const srv = makeServer({ isolationReport: ISOLATION_CLEANUP_PENDING_REPORT });
    const updateIsolationReport = vi.fn();
    const serverRepo = {
      findAll: vi.fn(() => [srv]),
      updateIsolationReport,
    } as unknown as IServerRepository;

    recoverInterruptedIsolationCleanup(serverRepo);

    // No other repository method (e.g. updateIsolationIntent, which would
    // imply a re-triggered transition) is ever called by this pass.
    expect(Object.keys(serverRepo)).not.toContain('updateIsolationIntent');
    expect(updateIsolationReport).toHaveBeenCalledTimes(1);
  });

  it('recovers multiple stranded rows in one pass and leaves non-pending rows alone', () => {
    const stuck1 = makeServer({ name: 'a', isolationReport: ISOLATION_CLEANUP_PENDING_REPORT });
    const stuck2 = makeServer({ name: 'b', isolationReport: ISOLATION_CLEANUP_PENDING_REPORT });
    const fine = makeServer({ name: 'c', isolationReport: JSON.stringify({ kind: 'cleanup', cleanup: 'done' }) });
    const updateIsolationReport = vi.fn();
    const serverRepo = {
      findAll: vi.fn(() => [stuck1, fine, stuck2]),
      updateIsolationReport,
    } as unknown as IServerRepository;

    const recoveredCount = recoverInterruptedIsolationCleanup(serverRepo);

    expect(recoveredCount).toBe(2);
    expect(updateIsolationReport).toHaveBeenCalledWith('a', expect.stringContaining('interrupted'));
    expect(updateIsolationReport).toHaveBeenCalledWith('b', expect.stringContaining('interrupted'));
    expect(updateIsolationReport).not.toHaveBeenCalledWith('c', expect.anything());
  });
});
