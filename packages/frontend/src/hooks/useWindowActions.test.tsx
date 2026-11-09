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

it('keeps workspace registration stable when reconnect callbacks change on render', async () => {
  const { MaximizedWindowProvider, useMaximizeActions } = await import('./useMaximizedWindow');
  const { HotkeyProvider } = await import('./useHotkeys');
  const { useEffect, useRef } = await import('react');
  const { render } = await import('@testing-library/react');
  const windows = new Map();
  let renders = 0;
  function WorkspaceRegistration() {
    renders++;
    const { setWorkspace } = useMaximizeActions();
    const actions = useWindowActions('1', () => {}, { showContextMenu: vi.fn(), showContextMenuAt: vi.fn(), findTaskByTarget: () => null, openTask: vi.fn(), tabs: [], closeTab: vi.fn(), reconnectWindow: async () => {} });
    const wake = useRef(actions.handleRespawnWindow);
    wake.current = actions.handleRespawnWindow;
    useEffect(() => {
      setWorkspace({ tabs: [], activeWindowId: null, activeTabId: null, windows, openWindowTab: () => {}, wakeWindow: async window => { await wake.current(window.id, {}); } });
      return () => setWorkspace(null);
    }, [setWorkspace]);
    return null;
  }
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  render(<HotkeyProvider><MaximizedWindowProvider><WorkspaceRegistration /></MaximizedWindowProvider></HotkeyProvider>);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(renders).toBeLessThan(10);
  vi.unstubAllGlobals();
});
