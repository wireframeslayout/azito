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
vi.mock('./useToast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

import { buildAgentCommand, isInsufficientResources } from './useAddWindowModal';

describe('buildAgentCommand', () => {
  it('returns empty for "none"', () => {
    expect(buildAgentCommand('none', '', 'claude')).toBe('');
  });

  it('returns trimmed custom command for "custom"', () => {
    expect(buildAgentCommand('custom', '', '', '  my-cmd --flag  ')).toBe('my-cmd --flag');
  });

  it('appends model to base command', () => {
    expect(buildAgentCommand('claude', 'opus', 'claude-code')).toBe('claude-code --model opus');
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
