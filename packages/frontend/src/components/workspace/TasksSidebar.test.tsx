import { fireEvent, render } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import TasksSidebar from './TasksSidebar';
import type { Task } from '../../pages/workspace/types';

vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../hooks/useActiveWindowRows', () => ({ useActiveWindowRows: () => ({ rows: [] }) }));
vi.mock('../../hooks/useRecentTasks', () => ({ useRecentTasks: () => ({ openedAt: {} }) }));
vi.mock('../../hooks/useGlobalFocus', () => ({ useGlobalFocus: () => ({ focus: { taskId: 7, windowId: 1 } }) }));
vi.mock('../../hooks/useBrowserGroups', () => ({ useBrowserGroups: () => ({ groups: {} }) }));
vi.mock('../../hooks/useOperationLinks', () => ({ useOperationLinks: () => ({ parents: new Map([[2, 1]]), error: false }) }));

beforeEach(() => { localStorage.clear(); localStorage.setItem('tasks-sidebar-expanded', '[7]'); });

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
