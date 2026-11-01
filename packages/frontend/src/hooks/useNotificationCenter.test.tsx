import { act, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { AgentActivityPayload } from '../types/notification';
import { NotificationCenterProvider, useNotificationCenter } from './useNotificationCenter';

const state = vi.hoisted(() => ({ handler: undefined as ((payload: AgentActivityPayload) => void) | undefined, watched: vi.fn() }));
vi.mock('./useAgentActivity', () => ({ useAgentActivity: () => ({ isWatched: state.watched }) }));
vi.mock('./useNotificationChannel', () => ({ useNotificationChannel: (handlers: { onAgentActivity: (payload: AgentActivityPayload) => void }) => { state.handler = handlers.onAgentActivity; } }));
vi.mock('./useCrossProjectNavigation', () => ({ useCrossProjectNavigation: () => ({ openTask: vi.fn(), openTaskInProject: vi.fn(), openTerminal: vi.fn() }) }));

function View() { const { notifications } = useNotificationCenter(); return <output>{notifications.length}</output>; }

it('suppresses a watched completion and passes its window ID to the focus check', () => {
  localStorage.clear();
  state.watched.mockReturnValue(true);
  render(<NotificationCenterProvider><View /></NotificationCenterProvider>);
  act(() => state.handler!({ serverName: 'local', target: 's:w', windowId: 42, running: false, source: 'manual', operation: false, reason: 'completed' }));
  expect(state.watched).toHaveBeenCalledWith('local', 's:w', 42);
  expect(screen.getByRole('status').textContent).toBe('0');
});
