import { describe, expect, it } from 'vitest';
import { paneCommand, type MisaoPane } from './misaoMapping';

function makePane(overrides: Partial<MisaoPane>): MisaoPane {
  return {
    paneId: '01',
    workspace: 'ws',
    window: { id: 'w1', name: 'win' },
    pid: 1,
    cols: 80,
    rows: 24,
    cwd: '/home',
    cmd: ['/bin/bash'],
    processState: 'running',
    title: '',
    fgCommand: undefined,
    lastOutputAt: null,
    labels: {},
    ...overrides,
  } as MisaoPane;
}

describe('paneCommand', () => {
  it('returns basename when cmd[0] is a full path', () => {
    expect(paneCommand(makePane({ cmd: ['/usr/bin/bash'], fgCommand: undefined }))).toBe('bash');
  });

  it('returns cmd[0] as-is when it has no directory component', () => {
    expect(paneCommand(makePane({ cmd: ['bash'], fgCommand: undefined }))).toBe('bash');
  });

  it('returns fgCommand when it is set', () => {
    expect(paneCommand(makePane({ cmd: ['/usr/bin/bash'], fgCommand: 'vim' }))).toBe('vim');
  });
});
