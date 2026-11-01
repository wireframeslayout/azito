import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { CrossProjectNavigationProvider, useCrossProjectNavigation } from './useCrossProjectNavigation';
import { apiWithStatus } from '../api/client';

const mocks = vi.hoisted(() => ({ task: vi.fn(), terminal: vi.fn(), toast: vi.fn(), tasks: [] as Array<{ id: number; projectId: number }>, registered: true }));
vi.mock('../api/client', () => ({ apiWithStatus: vi.fn() }));
vi.mock('./useWorkspaceTargets', () => ({ useWorkspaceTargets: () => ({ onOpenTask: mocks.registered ? mocks.task : null, onOpenInTerminal: mocks.registered ? mocks.terminal : null }) }));
vi.mock('./useWorkspaceCatalog', () => ({ useWorkspaceCatalog: () => ({ allTasks: mocks.tasks }) }));
vi.mock('./useToast', () => ({ useToast: () => ({ showToast: mocks.toast }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
function Controls() {
  const { openTask, openTaskInProject, openTerminal } = useCrossProjectNavigation();
  return <><button onClick={() => openTask(1)}>Task</button><button onClick={() => openTaskInProject(1, 2)}>Explicit</button><button onClick={() => openTerminal({ serverName: 'local', target: 'a' }, 2)}>Terminal</button></>;
}
function App({ path }: { path: string }) {
  return <MemoryRouter initialEntries={[path]}><CrossProjectNavigationProvider><Controls /><Routes><Route path="*" element={<div>Route</div>} /></Routes></CrossProjectNavigationProvider></MemoryRouter>;
}
beforeEach(() => { vi.clearAllMocks(); mocks.tasks = []; mocks.registered = true; });
it('opens a known task in the current project without fetching', () => {
  mocks.tasks = [{ id: 1, projectId: 1 }]; render(<App path="/workspace/1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Task' }));
  expect(mocks.task).toHaveBeenCalledWith(1); expect(apiWithStatus).not.toHaveBeenCalled();
});
it('opens an explicitly targeted task and terminal after navigation from a global page', async () => {
  mocks.tasks = [{ id: 1, projectId: 1 }]; render(<App path="/settings" />);
  fireEvent.click(screen.getByRole('button', { name: 'Explicit' }));
  await waitFor(() => expect(mocks.task).toHaveBeenCalledWith(1));
  fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
  expect(mocks.terminal).toHaveBeenCalledWith({ serverName: 'local', target: 'a' });
});
it('resolves an unknown task via API and reports failures', async () => {
  vi.mocked(apiWithStatus).mockResolvedValueOnce({ status: 200, body: { projectId: 2 } }).mockResolvedValueOnce({ status: 404, body: {} });
  render(<App path="/settings" />);
  fireEvent.click(screen.getByRole('button', { name: 'Task' }));
  await waitFor(() => expect(mocks.task).toHaveBeenCalledWith(1));
  fireEvent.click(screen.getByRole('button', { name: 'Task' }));
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('taskOpenFailed'));
});

it('expires a pending open when the workspace target is not registered in time', () => {
  vi.useFakeTimers();
  mocks.registered = false;
  const { rerender } = render(<App path="/settings" />);
  fireEvent.click(screen.getByRole('button', { name: 'Explicit' }));
  act(() => { vi.advanceTimersByTime(5000); });
  mocks.registered = true;
  rerender(<App path="/settings" />);
  expect(mocks.task).not.toHaveBeenCalled();
  vi.useRealTimers();
});
