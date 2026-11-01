import { describe, expect, it, vi } from 'vitest';
import { isAgentWindow, readWindowViewMode, resolveWindowViewMode, writeWindowViewMode } from './windowViewMode';

describe('window view mode', () => {
  it('prioritizes selection and defaults only mobile agent windows to chat', () => {
    for (const mobile of [false, true]) for (const agent of [false, true]) {
      expect(resolveWindowViewMode(1, null, mobile, agent)).toBe(mobile && agent ? 'chat' : 'terminal');
      expect(resolveWindowViewMode(1, 'chat', mobile, agent)).toBe('chat');
      expect(resolveWindowViewMode(1, 'terminal', mobile, agent)).toBe('terminal');
      expect(resolveWindowViewMode(null, 'chat', mobile, agent)).toBe('terminal');
    }
  });
  it('detects registered and running agents by window id', () => {
    expect(isAgentWindow(1, 'agent', [])).toBe(true);
    expect(isAgentWindow(1, 'shell', [{ windowId: 1 }])).toBe(true);
    expect(isAgentWindow(1, 'shell', [{ windowId: 2 }])).toBe(false);
    expect(isAgentWindow(null, 'agent', [])).toBe(false);
  });
  it('validates storage and tolerates inaccessible storage', () => {
    const getItem = vi.fn().mockReturnValueOnce('chat').mockReturnValueOnce('bad').mockImplementation(() => { throw Error(); });
    const setItem = vi.fn().mockImplementation(() => { throw Error(); });
    vi.stubGlobal('localStorage', { getItem, setItem });
    expect(readWindowViewMode(1)).toBe('chat');
    expect(readWindowViewMode(1)).toBeNull();
    expect(readWindowViewMode(1)).toBeNull();
    expect(() => writeWindowViewMode(1, 'terminal')).not.toThrow();
    vi.unstubAllGlobals();
  });
});
