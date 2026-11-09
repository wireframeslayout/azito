import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import TasksSidebar from './TasksSidebar';
import type { Task } from '../../pages/workspace/types';

vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));
const state = vi.hoisted(() => ({ rows: [] as unknown[], error: false, ids: [] as number[] }));
vi.mock('../../hooks/useActiveWindowRows', () => ({ useActiveWindowRows: () => ({ rows: state.rows }) }));
vi.mock('../../hooks/useRecentTasks', () => ({ useRecentTasks: () => ({ openedAt: {} }) }));
vi.mock('../../hooks/useGlobalFocus', () => ({ useGlobalFocus: () => ({ focus: { taskId: 7, windowId: 1 } }) }));
vi.mock('../../hooks/useBrowserGroups', () => ({ useBrowserGroups: () => ({ groups: {} }) }));
vi.mock('../../hooks/useOperationLinks', () => ({ useOperationLinks: (ids: number[]) => { state.ids = ids; return { parents: new Map([[2, 1]]), error: state.error }; } }));

beforeEach(() => { state.rows = []; state.error = false; localStorage.clear(); localStorage.setItem('tasks-sidebar-expanded', '[7]'); });

it('opens the operation group and navigates to its child without opening the parent', () => {
  const openWindow = vi.fn();
  const showWindowContextMenu = vi.fn();
  const task = { id: 7, title: 'Task', status: 'open', windows: [
    { id: 1, isPrimary: true, label: 'Parent', tmuxTarget: 's:1', serverName: 's' },
    { id: 2, isPrimary: false, label: 'Child', tmuxTarget: 's:2', serverName: 's' },
  ] } as Task;
  render(<TasksSidebar titleData={{} as never} tasks={[task]} showWindowContextMenu={showWindowContextMenu} onOpenTask={vi.fn()} onOpenAllTasks={vi.fn()} onCreateTask={vi.fn()} onOpenTaskWindow={openWindow} onOpenTaskBrowser={vi.fn()} />);
  const parent = document.querySelector('[data-window-id="1"]')!;
  expect(parent).toHaveAttribute('aria-expanded', 'false');
  expect(parent).toHaveAttribute('aria-selected', 'true');
  (parent as HTMLElement).focus();
  fireEvent.keyDown(parent, { key: 'ArrowRight' });
  expect(parent).toHaveAttribute('aria-expanded', 'true');
  const child = document.querySelector('[data-window-id="2"]') as HTMLElement;
  fireEvent.contextMenu(child);
  expect(showWindowContextMenu).toHaveBeenCalledTimes(1);
  expect(showWindowContextMenu.mock.calls[0][1].id).toBe(2);
  child.focus();
  fireEvent.keyDown(child, { key: 'Enter' });
  expect(openWindow).toHaveBeenCalledTimes(1);
  expect(openWindow).toHaveBeenCalledWith(7, 'Task', { serverName: 's', target: 's:2' });
  fireEvent.keyDown(child, { key: 'ArrowLeft' });
  expect(parent).toHaveFocus();
});

it('opens a group by default when a child is running and honors an explicitly saved closed state', () => {
  state.rows = [{ taskId: 7, status: 'running', serverName: 's', target: 's:2', key: 's/2', title: 'Child' }];
  const task = { id: 7, title: 'Task', status: 'open', windows: [{ id: 1, isPrimary: true, tmuxTarget: 's:1', serverName: 's' }, { id: 2, isPrimary: false, tmuxTarget: 's:2', serverName: 's' }] } as Task;
  const props = { titleData: {} as never, tasks: [task], onOpenTask: vi.fn(), onOpenAllTasks: vi.fn(), onCreateTask: vi.fn(), onOpenTaskWindow: vi.fn(), onOpenTaskBrowser: vi.fn() };
  const view = render(<TasksSidebar {...props} />);
  expect(document.querySelector('[data-window-id="1"]')).toHaveAttribute('aria-expanded', 'true');
  view.unmount();
  localStorage.setItem('tasks-sidebar-expanded-windows', '{"1":false}');
  render(<TasksSidebar {...props} />);
  expect(document.querySelector('[data-window-id="1"]')).toHaveAttribute('aria-expanded', 'false');
});

it('shows a notice when operation links cannot be loaded', () => {
  state.error = true;
  render(<TasksSidebar titleData={{} as never} tasks={[]} onOpenTask={vi.fn()} onOpenAllTasks={vi.fn()} onCreateTask={vi.fn()} onOpenTaskWindow={vi.fn()} onOpenTaskBrowser={vi.fn()} />);
  expect(screen.getByRole('status')).toHaveTextContent('sidebar.operationLinksError');
});

it('fetches links only for displayed tasks', () => {
  const tasks = [{ id: 7, title: 'Visible', status: 'open' }, { id: 8, title: 'Archived', status: 'archived' }] as Task[];
  render(<TasksSidebar titleData={{} as never} tasks={tasks} onOpenTask={vi.fn()} onOpenAllTasks={vi.fn()} onCreateTask={vi.fn()} onOpenTaskWindow={vi.fn()} onOpenTaskBrowser={vi.fn()} />);
  expect(state.ids).toEqual([7]);
});
