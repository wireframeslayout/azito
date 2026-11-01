import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { WorkspaceCatalogProvider, useWorkspaceCatalog } from './useWorkspaceCatalog';
import { apiWithStatus } from '../api/client';
import { PROJECTS_CHANGED_EVENT } from '../lib/projectsChanged';

vi.mock('../api/client', () => ({ apiWithStatus: vi.fn() }));
vi.mock('./useNotificationChannel', () => ({ useNotificationChannel: vi.fn() }));
const api = vi.mocked(apiWithStatus);
function View() {
  const { allProjects, allTasks, loading, error, refresh } = useWorkspaceCatalog();
  return <><output>{loading ? 'loading' : error ? 'error' : `${allProjects.length}:${allTasks.length}`}</output><button onClick={() => void refresh()}>Refresh</button></>;
}
it('loads both lists and retains the last success on failure', async () => {
  api.mockImplementation(async path => ({ status: 200, body: path === '/projects' ? [{ id: 1 }] : [{ id: 2 }] }));
  render(<WorkspaceCatalogProvider><View /></WorkspaceCatalogProvider>);
  await screen.findByText('1:1');
  api.mockResolvedValue({ status: 500, body: { error: 'failed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('error');
  api.mockResolvedValue({ status: 200, body: [] });
  window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
  await waitFor(() => expect(screen.getByText('0:0')).toBeInTheDocument());
});
it('ignores older requests that complete after a refresh', async () => {
  const pending: Array<(v: { status: number; body: unknown }) => void> = [];
  api.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  render(<WorkspaceCatalogProvider><View /></WorkspaceCatalogProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  pending[2]({ status: 200, body: [] }); pending[3]({ status: 200, body: [] });
  await screen.findByText('0:0');
  pending[0]({ status: 200, body: [{ id: 1 }] }); pending[1]({ status: 200, body: [{ id: 2 }] });
  await waitFor(() => expect(screen.getByText('0:0')).toBeInTheDocument());
});
