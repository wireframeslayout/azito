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
