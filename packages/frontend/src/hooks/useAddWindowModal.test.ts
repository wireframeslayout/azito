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

import { buildAgentCommand, buildNewWindowLaunch, isInsufficientResources } from './useAddWindowModal';

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

describe('buildNewWindowLaunch', () => {
  it("a Windows host starts the agent as the window's first pane in the one create call", () => {
    expect(buildNewWindowLaunch('win32', 'claude', "claude --model 'opus'", ' C:\\work ')).toEqual({ command: "claude --model 'opus'", workerType: 'claude', workingDirectory: 'C:\\work' });
    expect(buildNewWindowLaunch('win32', 'custom', 'my-tool --x', '')).toEqual({ command: 'my-tool --x', workerType: 'generic' });
  });

  it('other hosts, and a window with no agent, send no launch: the command is typed into the new shell afterwards', () => {
    expect(buildNewWindowLaunch('linux', 'claude', 'claude', '/work')).toBeUndefined();
    expect(buildNewWindowLaunch(undefined, 'claude', 'claude', '/work')).toBeUndefined();
    expect(buildNewWindowLaunch('win32', 'none', '', '')).toBeUndefined();
  });
});
