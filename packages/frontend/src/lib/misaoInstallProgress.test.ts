import { describe, expect, it } from 'vitest';
import { interpretInstallProgress } from './misaoInstallProgress';

describe('interpretInstallProgress', () => {
  it('reads the last step of a running install', () => {
    expect(interpretInstallProgress({ state: 'running', steps: ['inspect', 'transfer'] })).toEqual({ kind: 'running', step: 'transfer' });
    expect(interpretInstallProgress({ state: 'running', steps: [] })).toEqual({ kind: 'running', step: null });
  });

  it('ends on done, so the row stops following and checks the server again', () => {
    expect(interpretInstallProgress({ state: 'done', steps: ['start'] })).toEqual({ kind: 'done' });
  });

  it("ends on failed with the hub's error", () => {
    expect(interpretInstallProgress({ state: 'failed', steps: [], error: 'not x86_64', code: 'unsupported_host' })).toEqual({ kind: 'failed', error: 'not x86_64' });
    expect(interpretInstallProgress({ state: 'failed', steps: [] })).toEqual({ kind: 'failed', error: 'install failed' });
  });

  it('has nothing to follow when idle', () => {
    expect(interpretInstallProgress({ state: 'idle', steps: [] })).toEqual({ kind: 'idle' });
  });
});
