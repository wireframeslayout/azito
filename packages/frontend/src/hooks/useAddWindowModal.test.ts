import { describe, it, expect, vi } from 'vitest';

vi.mock('react', () => ({
  useState: vi.fn(() => [undefined, vi.fn()]),
  useCallback: vi.fn((fn: unknown) => fn),
  useMemo: vi.fn((fn: () => unknown) => (fn as () => unknown)()),
  useRef: vi.fn(() => ({ current: 0 })),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock('../api/client', () => ({ api: vi.fn() }));
vi.mock('./useAgentDefinitions', () => ({
  useAgentDefinitions: () => ({ agents: [], loading: false, error: null }),
}));
vi.mock('./useServerStatuses', () => ({
  useServerStatuses: () => ({ statuses: {} }),
}));
vi.mock('./useToast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('./useMisaoInstallOffer', () => ({
  useMisaoInstallOffer: () => <T,>(_serverName: string, create: () => Promise<T>) => create(),
}));

import { buildAgentCommand, isInsufficientResources, openAndLaunchNewWindow } from './useAddWindowModal';

describe('buildAgentCommand', () => {
  it('returns empty for "none"', () => {
    expect(buildAgentCommand('none', '', 'claude')).toBe('');
  });

  it('returns trimmed custom command for "custom"', () => {
    expect(buildAgentCommand('custom', '', '', '  my-cmd --flag  ')).toBe('my-cmd --flag');
  });

  it('appends model to base command', () => {
    expect(buildAgentCommand('claude', 'opus', 'claude-code')).toBe("claude-code --model 'opus'");
  });

  it('shell-quotes model IDs with brackets', () => {
    expect(buildAgentCommand('claude', 'claude-opus-5-5[1m]', 'claude-code')).toBe("claude-code --model 'claude-opus-5-5[1m]'");
  });

  it('returns base command when model is empty', () => {
    expect(buildAgentCommand('claude', '', 'claude-code')).toBe('claude-code');
  });
});

describe('isInsufficientResources', () => {
  it('detects 409 insufficient_resources response', () => {
    expect(isInsufficientResources({ error: 'insufficient_resources', resources: {} })).toBe(true);
  });

  it('rejects other error shapes', () => {
    expect(isInsufficientResources({ error: 'not_found' })).toBe(false);
    expect(isInsufficientResources(null)).toBe(false);
    expect(isInsufficientResources(42)).toBe(false);
  });
});

describe('openAndLaunchNewWindow', () => {
  function steps(log: string[], over: { changeDirectory?: boolean; launch?: boolean } = {}) {
    return {
      open: async () => { log.push('open'); },
      changeDirectory: over.changeDirectory === false ? null : async () => { log.push('cd'); },
      launch: over.launch === false ? null : async () => { log.push('launch'); },
    };
  }

  it('POSIX: opens the terminal, changes directory, then types the agent in', async () => {
    const log: string[] = [];
    await openAndLaunchNewWindow(false, steps(log));
    expect(log).toEqual(['open', 'cd', 'launch']);
  });

  it('a host that starts the worker as a program launches first and opens the terminal after, so it attaches to the new pane; no cd is sent', async () => {
    const log: string[] = [];
    await openAndLaunchNewWindow(true, steps(log));
    expect(log).toEqual(['launch', 'open']);
  });

  it('a plain shell window on such a host is opened as before (nothing replaces its pane)', async () => {
    const log: string[] = [];
    await openAndLaunchNewWindow(true, steps(log, { launch: false }));
    expect(log).toEqual(['open', 'cd']);
  });
});
