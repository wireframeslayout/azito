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
