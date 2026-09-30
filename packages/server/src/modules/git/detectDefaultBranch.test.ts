import { describe, it, expect, vi } from 'vitest';
import { detectDefaultBranch } from './detectDefaultBranch';
import type { IServerTransport } from '../servers/transport/ServerTransport';

function makeTransport(responses: Record<string, { stdout: string }>): IServerTransport {
  return {
    exec: vi.fn(async (cmd: string) => {
      for (const [key, value] of Object.entries(responses)) {
        if (cmd.includes(key)) return value;
      }
      return { stdout: '' };
    }),
  } as unknown as IServerTransport;
}

describe('detectDefaultBranch', () => {
  it('detects from origin/HEAD when set', async () => {
    const transport = makeTransport({
      'symbolic-ref': { stdout: 'refs/remotes/origin/main\n' },
    });
    expect(await detectDefaultBranch(transport, '/repo')).toBe('main');
  });

  it('detects master from origin/HEAD', async () => {
    const transport = makeTransport({
      'symbolic-ref': { stdout: 'refs/remotes/origin/master\n' },
    });
    expect(await detectDefaultBranch(transport, '/repo')).toBe('master');
  });

  it('falls back to main when origin/HEAD is absent and only main exists', async () => {
    const transport = makeTransport({
      'symbolic-ref': { stdout: '' },
      'refs/heads/main': { stdout: 'a'.repeat(40) + '\n' },
      'refs/heads/master': { stdout: '' },
    });
    expect(await detectDefaultBranch(transport, '/repo')).toBe('main');
  });

  it('falls back to master when origin/HEAD is absent and only master exists', async () => {
    const transport = makeTransport({
      'symbolic-ref': { stdout: '' },
      'refs/heads/main': { stdout: '' },
      'refs/heads/master': { stdout: 'b'.repeat(40) + '\n' },
    });
    expect(await detectDefaultBranch(transport, '/repo')).toBe('master');
  });

  it('returns null when both main and master exist (ambiguous)', async () => {
    const transport = makeTransport({
      'symbolic-ref': { stdout: '' },
      'refs/heads/main': { stdout: 'a'.repeat(40) + '\n' },
      'refs/heads/master': { stdout: 'b'.repeat(40) + '\n' },
    });
    expect(await detectDefaultBranch(transport, '/repo')).toBeNull();
  });

  it('returns null when neither main nor master exists', async () => {
    const transport = makeTransport({
      'symbolic-ref': { stdout: '' },
      'refs/heads/main': { stdout: '' },
      'refs/heads/master': { stdout: '' },
    });
    expect(await detectDefaultBranch(transport, '/repo')).toBeNull();
  });

  it('falls back when origin/HEAD contains an error message', async () => {
    const transport = makeTransport({
      'symbolic-ref': { stdout: 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref\n' },
      'refs/heads/main': { stdout: '' },
      'refs/heads/master': { stdout: 'c'.repeat(40) + '\n' },
    });
    expect(await detectDefaultBranch(transport, '/repo')).toBe('master');
  });

  it('detects a non-standard branch from origin/HEAD', async () => {
    const transport = makeTransport({
      'symbolic-ref': { stdout: 'refs/remotes/origin/develop\n' },
    });
    expect(await detectDefaultBranch(transport, '/repo')).toBe('develop');
  });
});
