import { renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useWindowActions } from './useWindowActions';

vi.mock('../api/client', () => ({ api: vi.fn(async (path: string) => path.endsWith('/respawn') ? { ok: true, tmuxTarget: 'new:target' } : []) }));
vi.mock('./useOrchestratorRole', () => ({ useOrchestratorRole: () => vi.fn() }));
vi.mock('./useWakeWindow', () => ({ useWakeWindow: () => ({ choose: vi.fn(async () => 'tmux'), dialog: null }) }));
vi.mock('./useAgentActivity', () => ({ useAgentActivity: () => ({ activityStatus: () => null }) }));
vi.mock('./useToast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

it('retargets existing tabs after wake without opening an extra tab', async () => {
  const reconnect = vi.fn();
  const { result } = renderHook(() => useWindowActions('1', vi.fn(), {
    showContextMenu: vi.fn(), showContextMenuAt: vi.fn(), findTaskByTarget: () => null,
    openTask: vi.fn(), tabs: [], closeTab: vi.fn(), reconnectWindow: reconnect,
  }));
  await result.current.handleRespawnWindow(42, { serverName: 'host', reconnect: 'existing' });
  await waitFor(() => expect(reconnect).toHaveBeenCalledWith({ serverName: 'host', windowId: 42, tmuxTarget: 'new:target' }, 'existing'));
});

it('keeps the actions context stable as workspace and selection change', async () => {
  const { MaximizedWindowProvider, useMaximizeActions } = await import('./useMaximizedWindow');
  const { HotkeyProvider } = await import('./useHotkeys');
  const { act } = await import('@testing-library/react');
  const { createElement } = await import('react');
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const wrapper = ({ children }: { children: React.ReactNode }) => createElement(HotkeyProvider, null, createElement(MaximizedWindowProvider, null, children));
  const { result } = renderHook(() => useMaximizeActions(), { wrapper });
  const original = result.current;
  act(() => original.setWorkspace({ tabs: [], activeWindowId: null, activeTabId: null, windows: new Map(), openWindowTab: () => {}, wakeWindow: async () => {} }));
  expect(result.current).toBe(original);
  act(() => original.open(42));
  expect(result.current).toBe(original);
  act(() => original.close());
  expect(result.current).toBe(original);
  vi.unstubAllGlobals();
});
