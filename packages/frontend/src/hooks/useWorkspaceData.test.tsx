import { render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useWorkspaceData } from './useWorkspaceData';
import { fetchSessionListing } from '../lib/fetchServerSessions';

const mocks = vi.hoisted(() => ({ tasks: [{ id: 1, projectId: 1, windows: [] }, { id: 2, projectId: 2, windows: [] }] as Array<{ id: number; projectId: number; windows: Array<{ serverName: string; tmuxTarget: string }> }>, refresh: vi.fn(async () => {}) }));
vi.mock('./useWorkspaceCatalog', () => ({ useWorkspaceCatalog: () => ({ allTasks: mocks.tasks, allProjects: [], projectsLoaded: true, refresh: mocks.refresh }) }));
vi.mock('../lib/fetchServerSessions', () => ({ fetchSessionListing: vi.fn(async () => ({ sessions: [] })), keepUnavailableKinds: vi.fn(() => []) }));
vi.mock('./useNotificationChannel', () => ({ useNotificationChannel: vi.fn() }));
vi.mock('../api/client', () => ({ api: vi.fn(async (path: string) => path.startsWith('/projects/') && !path.endsWith('/servers') ? { id: Number(path.split('/')[2]), windows: [] } : []) }));
function View({ project }: { project: string }) {
  const data = useWorkspaceData(project, [], 'tasks');
  return <output>{data.tasks.map(t => t.id).join(',')}</output>;
}
it('derives the active project tasks immediately when switching projects', async () => {
  const { rerender } = render(<View project="1" />);
  expect(screen.getByText('1')).toBeInTheDocument();
  rerender(<View project="2" />);
  await waitFor(() => expect(screen.getByText('2')).toBeInTheDocument());
});

it('refreshes sessions when a task-owned window appears', async () => {
  mocks.tasks = [{ id: 1, projectId: 1, windows: [] }];
  const { rerender } = render(<View project="1" />);
  mocks.tasks = [{ id: 1, projectId: 1, windows: [{ serverName: 'agent', tmuxTarget: 'session:1' }] }];
  rerender(<View project="1" />);
  await waitFor(() => expect(fetchSessionListing).toHaveBeenCalledWith('agent'));
});

it('keeps the derived tasks reference while the catalog list is unchanged', () => {
  mocks.tasks = [{ id: 1, projectId: 1, windows: [] }];
  const seen: unknown[] = [];
  function Probe({ tick }: { tick: number }) {
    const data = useWorkspaceData('1', [], 'tasks');
    seen.push(data.tasks);
    return <output>{tick}</output>;
  }
  const { rerender } = render(<Probe tick={0} />);
  rerender(<Probe tick={1} />);
  expect(seen.length).toBeGreaterThanOrEqual(2);
  expect(seen[seen.length - 1]).toBe(seen[0]);
});
