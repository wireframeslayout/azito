import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceCatalogProvider, useWorkspaceCatalog } from './useWorkspaceCatalog';
import { apiWithStatus } from '../api/client';
import { PROJECTS_CHANGED_EVENT } from '../lib/projectsChanged';

vi.mock('../api/client', () => ({ apiWithStatus: vi.fn() }));
const events = vi.hoisted(() => ({ handlers: {} as { onTaskStatus?: () => void; onWorkspaceRefresh?: () => void } }));
vi.mock('./useNotificationChannel', () => ({ useNotificationChannel: (handlers: typeof events.handlers) => { events.handlers = handlers; } }));
const api = vi.mocked(apiWithStatus);
beforeEach(() => { api.mockReset(); });
function View() {
  const { allProjects, allTasks, loading, error, refresh } = useWorkspaceCatalog();
  return <><output>{loading ? 'loading' : error ? 'error' : `${allProjects.length}:${allTasks.length}`}</output><span aria-label="counts">{allProjects.length}:{allTasks.length}</span><button onClick={() => void refresh()}>Refresh</button></>;
}
it('loads both lists and retains the last success on failure', async () => {
  api.mockImplementation(async path => ({ status: 200, body: path === '/projects' ? [{ id: 1 }] : [{ id: 2 }] }));
  render(<WorkspaceCatalogProvider><View /></WorkspaceCatalogProvider>);
  await waitFor(() => expect(screen.getByLabelText('counts')).toHaveTextContent('1:1'));
  api.mockResolvedValue({ status: 500, body: { error: 'failed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('error');
  expect(screen.getByLabelText('counts')).toHaveTextContent('1:1');
  api.mockResolvedValue({ status: 200, body: [] });
  window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
  await waitFor(() => expect(screen.getByLabelText('counts')).toHaveTextContent('0:0'));
});
it('ignores older requests that complete after a refresh', async () => {
  const pending: Array<(v: { status: number; body: unknown }) => void> = [];
  api.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  render(<WorkspaceCatalogProvider><View /></WorkspaceCatalogProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  pending[2]({ status: 200, body: [] }); pending[3]({ status: 200, body: [] });
  await waitFor(() => expect(screen.getByLabelText('counts')).toHaveTextContent('0:0'));
  pending[0]({ status: 200, body: [{ id: 1 }] }); pending[1]({ status: 200, body: [{ id: 2 }] });
  await waitFor(() => expect(screen.getByLabelText('counts')).toHaveTextContent('0:0'));
});

it('refreshes in response to task and workspace events', async () => {
  api.mockResolvedValue({ status: 200, body: [] });
  render(<WorkspaceCatalogProvider><View /></WorkspaceCatalogProvider>);
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  act(() => { events.handlers.onTaskStatus?.(); events.handlers.onWorkspaceRefresh?.(); });
  await waitFor(() => expect(api).toHaveBeenCalledTimes(6));
});
it('rejects use outside the provider', () => {
  expect(() => renderHook(() => useWorkspaceCatalog())).toThrow('useWorkspaceCatalog must be used within WorkspaceCatalogProvider');
});
