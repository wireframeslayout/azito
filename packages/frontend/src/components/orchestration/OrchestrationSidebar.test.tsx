// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OrchestrationSidebar } from './OrchestrationSidebar';

vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
const removeRole = vi.fn();
vi.mock('../../hooks/useOrchestrationModel', async () => { const { buildOrchestratorTree } = await import('../../lib/orchestrationModel'); return { useOrchestrationModel: () => ({ tree: buildOrchestratorTree([{ id: 1, originProjectId: 10, parentWindowId: null, label: 'Parent', tmuxTarget: 's:p', serverName: 'local', links: { targets: [], total: 0, projectIds: [], serverNames: [] } }, { id: 2, originProjectId: 10, parentWindowId: 1, label: 'Child', tmuxTarget: 's:c', serverName: 'local', links: { targets: [{ windowId: null, taskId: 8 }], total: 1, projectIds: [10], serverNames: [] } }, { id: 3, originProjectId: 10, parentWindowId: null, label: null, tmuxTarget: 's:w_01M741SYR07', serverName: 'local', links: { targets: [], total: 0, projectIds: [], serverNames: [] } }] as never, { activityByWindowId: new Map(), taskById: new Map([[8, { id: 8, status: 'failed' } as never]]) }), activity: new Map() }) }; });
vi.mock('../../hooks/useWindowActions', () => ({ useWindowActions: () => ({ getWindowMenuItems: (window: { id: number }) => [{ kind: 'change-role', label: 'orchestration.removeRole', onClick: () => removeRole(window.id) }], confirmDialog: null, respawnResourceWarning: null }) }));
vi.mock('../../hooks/useWorkspaceCatalog', () => ({ useWorkspaceCatalog: () => ({ allProjects: [{ id: 10, name: 'Project Alpha' }] }) }));
vi.mock('../../hooks/useAgentActivity', () => ({ useAgentActivity: () => ({ activityStatus: () => null, snapshotStatus: 'ready', retrySnapshot: vi.fn() }) }));
vi.mock('../../hooks/useOrchestrators', () => ({ useOrchestrators: () => ({ status: 'ready', refresh: vi.fn(), windows: [
  { id: 1, originProjectId: 10, parentWindowId: null, label: 'Parent', tmuxTarget: 's:p', serverName: 'local', links: { targets: [], total: 0, projectIds: [], serverNames: [] } },
  { id: 2, originProjectId: 10, parentWindowId: 1, label: 'Child', tmuxTarget: 's:c', serverName: 'local', links: { targets: [], total: 0, projectIds: [10], serverNames: [] } },
] }) }));
vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));

describe('OrchestrationSidebar', () => {
  it('shows matching ancestors and selects a child', () => {
    const select = vi.fn();
    render(<OrchestrationSidebar onSelect={select} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Child' } });
    expect(screen.getByText(/Parent/)).toBeTruthy();
    fireEvent.click(screen.getByText(/Child/));
    expect(select).toHaveBeenCalledWith(2);
  });
  it('shows and searches the resolved name for an unnamed window', () => {
    render(<OrchestrationSidebar onSelect={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'W-3' } });
    const row = screen.getByRole('treeitem', { name: 'W-3' });
    expect(row).toHaveTextContent('W-3');
    expect(row).not.toHaveTextContent('w_01M741SYR07');
    expect(row.textContent?.match(/W-3/g)).toHaveLength(1);
  });
  it('finds a child by linked project name', () => {
    render(<OrchestrationSidebar onSelect={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Project Alpha' } });
    expect(screen.getByText(/Parent/)).toBeTruthy();
    expect(screen.getByText(/Child/)).toBeTruthy();
  });
  it('moves focus between rows with arrow keys', () => {
    render(<OrchestrationSidebar onSelect={vi.fn()} />);
    const parent = screen.getByRole('treeitem', { name: /Parent/ });
    parent.focus();
    fireEvent.keyDown(parent, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: /Child/ }));
  });
  it('moves between parent and child with left and right', () => {
    render(<OrchestrationSidebar onSelect={vi.fn()} />);
    const parent = screen.getByRole('treeitem', { name: /Parent/ });
    const child = screen.getByRole('treeitem', { name: /Child/ });
    parent.focus();
    fireEvent.keyDown(parent, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(child);
    fireEvent.keyDown(child, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(parent);
  });
  it('opens the role action from the context menu', () => {
    render(<OrchestrationSidebar onSelect={vi.fn()} />);
    fireEvent.contextMenu(screen.getByText(/Parent/));
    fireEvent.click(screen.getAllByText('orchestration.returnToProject').at(-1)!);
    expect(removeRole).toHaveBeenCalledWith(1);
  });
  it('collapses children', () => {
    render(<OrchestrationSidebar onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'orchestration.collapse' }));
    expect(screen.queryByText(/Child/)).toBeNull();
  });
  it('opens the child menu on long press, never the parent menu', () => {
    vi.useFakeTimers();
    render(<OrchestrationSidebar onSelect={vi.fn()} />);
    const child = screen.getByText(/Child/);
    fireEvent.touchStart(child, { touches: [{ clientX: 30, clientY: 40 }] });
    act(() => vi.advanceTimersByTime(501));
    fireEvent.touchEnd(child, { changedTouches: [{ clientX: 30, clientY: 40 }] });
    fireEvent.click(screen.getByText('orchestration.returnToProject'));
    expect(removeRole).toHaveBeenLastCalledWith(2);
    vi.useRealTimers();
  });
  it('does not open a menu on a short child tap', () => {
    vi.useFakeTimers();
    render(<OrchestrationSidebar onSelect={vi.fn()} />);
    const child = screen.getByText(/Child/);
    fireEvent.touchStart(child, { touches: [{ clientX: 30, clientY: 40 }] });
    act(() => vi.advanceTimersByTime(100));
    fireEvent.touchEnd(child, { changedTouches: [{ clientX: 30, clientY: 40 }] });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByText('orchestration.returnToProject')).toBeNull();
    vi.useRealTimers();
  });

  it('shows descendant attention in the row description', () => {
    render(<OrchestrationSidebar onSelect={vi.fn()} />);
    const parent = screen.getByRole('treeitem', { name: 'Parent' });
    expect(document.getElementById(parent.getAttribute('aria-describedby')!)).toHaveTextContent('orchestration.attention');
  });

});
