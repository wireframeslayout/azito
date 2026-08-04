import { describe, it, expect } from 'vitest';

// Test the exit code extraction logic from agentRoutes
function extractExitCode(err: { code?: unknown } | null): number {
  const raw = (err as { code?: unknown } | null)?.code;
  return err ? (typeof raw === 'number' ? raw : 1) : 0;
}

describe('agentRoutes exit code extraction', () => {
  it('should return 0 when no error', () => {
    expect(extractExitCode(null)).toBe(0);
  });

  it('should return numeric exit code from error', () => {
    expect(extractExitCode({ code: 2 })).toBe(2);
  });

  it('should return 1 when error has string code (ENOENT)', () => {
    expect(extractExitCode({ code: 'ENOENT' })).toBe(1);
  });

  it('should return 1 when error has null code (signal kill)', () => {
    expect(extractExitCode({ code: null })).toBe(1);
  });

  it('should return 1 when error has undefined code', () => {
    expect(extractExitCode({ code: undefined })).toBe(1);
  });

  it('should return 1 when error has no code property', () => {
    expect(extractExitCode({})).toBe(1);
  });

  it('should return exit code 0 from error (edge case)', () => {
    // A process can exit with code 0 but still produce stderr,
    // though execFile wouldn't set err in that case
    expect(extractExitCode({ code: 0 })).toBe(0);
  });
});

/**
 * Same-host check for POST /api/hooks/tmux, mirroring agent/routes.ts.
 *
 * The agent binds to a routable address (a Tailscale IP; 0.0.0.0 is rejected at
 * startup) so the hub can reach it, and registers its tmux hooks against that
 * same address. Requests the host sends to its own address therefore arrive
 * with that address as their source, never a loopback one — accepting only
 * loopback silently rejected every hook the agent had itself installed, so tmux
 * events never reached the hub.
 */
function isSameHost(remoteIp: string, bindAddress: string): boolean {
  return (
    remoteIp === '127.0.0.1' ||
    remoteIp === '::1' ||
    remoteIp === '::ffff:127.0.0.1' ||
    remoteIp === bindAddress ||
    remoteIp === `::ffff:${bindAddress}`
  );
}

describe('agent tmux hook same-host check', () => {
  const BIND = '100.64.1.42';

  it('accepts loopback', () => {
    expect(isSameHost('127.0.0.1', BIND)).toBe(true);
    expect(isSameHost('::1', BIND)).toBe(true);
    expect(isSameHost('::ffff:127.0.0.1', BIND)).toBe(true);
  });

  it("accepts the agent's own bind address (its own hooks reach it this way)", () => {
    expect(isSameHost(BIND, BIND)).toBe(true);
    expect(isSameHost(`::ffff:${BIND}`, BIND)).toBe(true);
  });

  it('rejects other tailnet peers', () => {
    expect(isSameHost('100.64.1.43', BIND)).toBe(false);
    expect(isSameHost('::ffff:100.64.1.43', BIND)).toBe(false);
  });

  it('rejects arbitrary remote addresses', () => {
    expect(isSameHost('10.0.0.5', BIND)).toBe(false);
    expect(isSameHost('203.0.113.7', BIND)).toBe(false);
  });
});
