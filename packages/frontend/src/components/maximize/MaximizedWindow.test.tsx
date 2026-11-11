import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { HotkeyProvider } from '../../hooks/useHotkeys';
import { MaximizedWindowProvider, useMaximizedWindow } from '../../hooks/useMaximizedWindow';
import { MaximizedWindow } from './MaximizedWindow';
import { TabBar } from '../ui/TabBar';
import type { Window } from '../../pages/workspace/types';

const activity = vi.hoisted(() => ({ status: 'ready' as 'ready' | 'loading' | 'error', updatedAt: 1 as number | null, values: new Map<string, 'working' | 'blocked'>() }));
vi.mock('../../hooks/useAgentActivity', () => ({ useAgentActivity: () => ({ entries: new Map(), snapshotStatus: activity.status, snapshotUpdatedAt: activity.updatedAt, activityStatus: (server: string, target: string) => activity.values.get(`${server}:${target.replace(/\.\d+$/, '')}`) ?? null }) }));
afterEach(() => { activity.status = 'ready'; activity.updatedAt = 1; activity.values.clear(); });
const orchestrationState = vi.hoisted(() => ({ tree: [] as unknown[], read: vi.fn() }));
vi.mock('../../hooks/useOrchestrationModel', () => ({ useOrchestrationModel: () => { orchestrationState.read(); return { tree: orchestrationState.tree }; } }));
const linkedState = vi.hoisted(() => ({ links: [] as unknown[], error: null as Error | null, refresh: vi.fn() }));
vi.mock('../../hooks/useOrchestrationLinks', () => ({ useOrchestrationLinks: (id: number | null) => ({ links: id === null ? [] : linkedState.links, loading: false, error: id === null ? null : linkedState.error, refresh: linkedState.refresh }) }));
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../hooks/useWorkspaceCatalog', () => ({ useWorkspaceCatalog: () => ({ allTasks: [], allProjects: [], refresh: vi.fn() }) }));
vi.mock('../../hooks/useWorkspaceTargets', () => ({ useWorkspaceTargets: () => ({ onOpenTask: null }) }));
vi.mock('../../hooks/useOperationLinks', () => ({ useOperationLinks: () => ({ parents: new Map(), error: false, reload: vi.fn() }) }));
const mounts = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn(), wake: vi.fn(async () => {}) }));
vi.mock('../TerminalContainer', () => ({ TerminalContainer: ({ registeredWindow, viewMode }: { registeredWindow: { id: number }; viewMode: string }) => {
  useEffect(() => { mounts.connect(registeredWindow.id); return () => mounts.disconnect(registeredWindow.id); }, [registeredWindow.id]);
  return <div className="xterm" data-view-mode={viewMode}><textarea aria-label="terminal" /></div>;
} }));
const media = { narrow: false };
beforeAll(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: () => ({ matches: media.narrow, addEventListener: vi.fn(), removeEventListener: vi.fn() }) }); });
const first = { id: 1, serverName: 'host', tmuxTarget: 'one', label: 'One', role: 'orchestrator' } as Window;
const second = { id: 2, serverName: 'host', tmuxTarget: 'two', label: 'Two' } as Window;
function Workspace() {
  const { setWorkspace, open } = useMaximizedWindow();
  const [showSecond, setShowSecond] = useState(true);
  const [menu, setMenu] = useState(false);
  useEffect(() => { setWorkspace({ tabs: showSecond ? [{ kind: 'window', windowId: 1 }, { kind: 'window', windowId: 2 }] : [{ kind: 'window', windowId: 1 }], activeWindowId: 1, activeTabId: 'tab-one', windows: new Map(showSecond ? [[1, first], [2, second]] : [[1, first]]), openWindowTab: vi.fn(), wakeWindow: mounts.wake }); return () => setWorkspace(null); }, [setWorkspace, showSecond]);
  return <><TabBar tabs={[{ id: 'tab-one', label: 'Tab one' }]} activeId="tab-one" onSelect={() => {}} onTabContextMenu={() => setMenu(true)} />{menu && <button onClick={() => { setMenu(false); open(1); }}>Expand from menu</button>}<button onClick={() => open(1)}>Launch</button><button onClick={() => open(99)}>Missing</button><button onClick={() => setShowSecond(value => !value)}>Change tabs</button><input aria-label="outside input" /></>;
}
describe('maximized window', () => {
  it('shows the selected window activity and distinguishes unavailable snapshots from idle', async () => {
    activity.status = 'loading'; activity.updatedAt = null; activity.values.clear();
    const view = render(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    fireEvent.click(screen.getByText('Launch'));
    const header = (await screen.findByRole('dialog')).querySelector('header')!;
    expect(header).toHaveTextContent('Status unavailable');
    activity.status = 'ready'; activity.updatedAt = 1;
    view.rerender(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    expect(header).toHaveTextContent('Idle');
    activity.status = 'loading';
    view.rerender(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    expect(header).toHaveTextContent('Idle');
    activity.status = 'ready'; activity.values.set('host:one', 'working'); activity.values.set('host:two', 'blocked');
    view.rerender(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    expect(header).toHaveTextContent('Working');
    fireEvent.click(screen.getByRole('treeitem', { name: /Two/ }));
    expect(header).toHaveTextContent('Needs attention');
    activity.status = 'error';
    view.rerender(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    expect(header).toHaveTextContent('Status unavailable');
    activity.status = 'loading';
    view.rerender(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    expect(header).toHaveTextContent('Status unavailable');
    activity.status = 'ready';
    view.rerender(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    expect(header).toHaveTextContent('Needs attention');
  });
  it('switches connections and returns focus to its opener', async () => {
    mounts.connect.mockClear(); mounts.disconnect.mockClear();
    render(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    screen.getByText('Launch').focus(); fireEvent.click(screen.getByText('Launch'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(mounts.connect).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole('treeitem', { name: /Two/ }));
    await waitFor(() => expect(mounts.connect).toHaveBeenCalledWith(2));
    expect(mounts.disconnect).toHaveBeenCalledWith(1);
    expect(mounts.disconnect.mock.invocationCallOrder[0]).toBeLessThan(mounts.connect.mock.invocationCallOrder[1]);
    fireEvent.keyDown(screen.getByLabelText('terminal'), { key: 'Escape' });
    await new Promise(resolve => setTimeout(resolve));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(mounts.disconnect).toHaveBeenCalledWith(2));
    await waitFor(() => expect(screen.getByText('Launch')).toHaveFocus());
  });
  it('switches the maximized content from the header control', async () => {
    localStorage.removeItem('azito.windowView.1');
    render(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    fireEvent.click(screen.getByText('Launch'));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    expect(screen.getByLabelText('terminal').parentElement).toHaveAttribute('data-view-mode', 'chat');
  });
  it('opens an unresolved ID without substituting another window', async () => {
    render(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    fireEvent.click(screen.getByText('Missing'));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Window not found');
    expect(screen.queryByLabelText('terminal')).not.toBeInTheDocument();
  });
  it('handles the shortcut in an input and keeps roving focus after tab changes', async () => {
    render(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    fireEvent.click(screen.getByText('Change tabs'));
    fireEvent.keyDown(screen.getByLabelText('outside input'), { key: 'M', ctrlKey: true, shiftKey: true });
    await screen.findByRole('dialog');
    expect(screen.queryByRole('treeitem', { name: /Two/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Change tabs'));
    expect(await screen.findByRole('treeitem', { name: /Two/ })).toBeInTheDocument();
    const firstRow = screen.getByRole('treeitem', { name: /One/ });
    expect(firstRow).toHaveAttribute('aria-level', '1');
    firstRow.focus();
    fireEvent.keyDown(firstRow, { key: 'ArrowDown' });
    expect(screen.getByRole('treeitem', { name: /Two/ })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('treeitem', { name: /Two/ }), { key: ' ' });
    expect(mounts.connect).not.toHaveBeenLastCalledWith(2);
    fireEvent.click(screen.getByText('Change tabs'));
    await waitFor(() => expect(screen.queryByRole('treeitem', { name: /Two/ })).not.toBeInTheDocument());
    await waitFor(() => expect(firstRow).toHaveFocus());
  });

  it('shows linked targets and retries a failed link request without closing the terminal', async () => {
    linkedState.error = new Error('offline'); linkedState.refresh.mockClear();
    render(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    fireEvent.click(screen.getByText('Launch'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load window hierarchy');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(linkedState.refresh).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('terminal')).toBeInTheDocument();
    linkedState.error = null;
  });

  it('opens a resolved linked window absent from the workspace catalog', async () => {
    const linked = { ...second, id: 42, label: 'Linked', projectId: null, taskId: null, role: null };
    linkedState.links = [{ id: 10, kind: 'orchestration', unlinkedAt: null, sourceWindowId: 1, targetWindowId: 42, taskId: null, resolvedTaskId: null, resolvedWindowId: 42, resolvedWindow: linked, lastInteractionAt: null }];
    render(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    fireEvent.click(screen.getByText('Launch'));
    fireEvent.click(await screen.findByRole('treeitem', { name: /Linked/ }));
    await waitFor(() => expect(mounts.connect).toHaveBeenLastCalledWith(42));
    const trees = screen.getAllByRole('tree');
    expect(trees[0].querySelectorAll('[role=treeitem][tabindex="0"]')).toHaveLength(1);
    expect(trees[1].querySelectorAll('[role=treeitem][tabindex="0"]')).toHaveLength(1);
    linkedState.links = [];
  });

  it('shows child orchestrators with their label and icon', async () => {
    const child = { ...second, id: 7, label: 'Coordinator', role: 'orchestrator' };
    orchestrationState.tree = [{ window: first, children: [{ window: child, children: [] }] }];
    render(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    fireEvent.click(screen.getByText('Launch'));
    const row = await screen.findByRole('treeitem', { name: /Coordinator/ });
    expect(row).toHaveTextContent('Child');
    expect(row.querySelector('svg')).toHaveStyle({ color: 'var(--purple)' });
    orchestrationState.tree = [];
  });
  it('resolves a linked window reached by Alt navigation', async () => {
    const linked = { ...second, id: 42, label: 'Linked', projectId: null, taskId: null, role: null };
    linkedState.links = [{ id: 10, kind: 'orchestration', unlinkedAt: null, sourceWindowId: 1, targetWindowId: 42, taskId: null, resolvedTaskId: null, resolvedWindowId: 42, resolvedWindow: linked, lastInteractionAt: null }];
    render(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    fireEvent.click(screen.getByText('Launch'));
    await screen.findByRole('treeitem', { name: /Linked/ });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowUp', altKey: true });
    await waitFor(() => expect(mounts.connect).toHaveBeenLastCalledWith(42));
    expect(screen.queryByText('Window not found')).not.toBeInTheDocument();
    linkedState.links = [];
  });

  it('keeps the linked sequence after selection and navigates to another resolved target', async () => {
    const makeLink = (id: number) => ({ id, kind: 'orchestration', unlinkedAt: null, sourceWindowId: 1, targetWindowId: id, taskId: null, resolvedTaskId: null, resolvedWindowId: id, resolvedWindow: { ...second, id, label: `Linked ${id}`, projectId: null, taskId: null, role: null }, lastInteractionAt: null });
    linkedState.links = [makeLink(42), makeLink(43)];
    render(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    fireEvent.click(screen.getByText('Launch'));
    fireEvent.click(await screen.findByRole('treeitem', { name: /Linked 42/ }));
    await waitFor(() => expect(mounts.connect).toHaveBeenLastCalledWith(42));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown', altKey: true });
    await waitFor(() => expect(mounts.connect).toHaveBeenLastCalledWith(43));
    expect(screen.queryByText('Window not found')).not.toBeInTheDocument();
    linkedState.links = [];
  });

  it('wakes a linked window even when it is absent from the workspace catalog', async () => {
    const linked = { ...second, id: 42, label: 'Sleeping linked', sleeping: true, projectId: null, taskId: null, role: null };
    linkedState.links = [{ id: 10, kind: 'orchestration', unlinkedAt: null, sourceWindowId: 1, targetWindowId: 42, taskId: null, resolvedTaskId: null, resolvedWindowId: 42, resolvedWindow: linked, lastInteractionAt: null }];
    mounts.wake.mockClear();
    render(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    fireEvent.click(screen.getByText('Launch'));
    fireEvent.click(await screen.findByRole('treeitem', { name: /Sleeping linked/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Wake window' }));
    await waitFor(() => expect(mounts.wake).toHaveBeenCalledWith(expect.objectContaining({ id: 42, serverName: 'host' })));
    linkedState.links = [];
  });

  it('shows a missing window after a selected registered window is deleted', async () => {
    render(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    fireEvent.click(screen.getByText('Launch'));
    fireEvent.click(await screen.findByRole('treeitem', { name: /Two/ }));
    await waitFor(() => expect(mounts.connect).toHaveBeenLastCalledWith(2));
    fireEvent.click(screen.getByText('Change tabs'));
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Window not found'));
    expect(screen.queryByLabelText('terminal')).not.toBeInTheDocument();
  });

  it('shows missing when a previously resolved linked window is deleted', async () => {
    const link = { id: 10, kind: 'orchestration', unlinkedAt: null, sourceWindowId: 1, targetWindowId: 42, taskId: null, resolvedTaskId: null, resolvedWindowId: 42, resolvedWindow: { ...second, id: 42, label: 'Linked', projectId: null, taskId: null, role: null }, lastInteractionAt: null };
    linkedState.links = [link];
    render(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    fireEvent.click(screen.getByText('Launch'));
    fireEvent.click(await screen.findByRole('treeitem', { name: /Linked/ }));
    await waitFor(() => expect(mounts.connect).toHaveBeenLastCalledWith(42));
    linkedState.links = [{ ...link, resolvedWindowId: null, resolvedWindow: null }];
    fireEvent.click(screen.getByText('Change tabs'));
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Window not found'));
    linkedState.links = [];
  });

  it('does not build orchestration data while closed', async () => {
    orchestrationState.read.mockClear();
    render(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    expect(orchestrationState.read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Launch'));
    expect(orchestrationState.read).toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    orchestrationState.read.mockClear();
    fireEvent.click(screen.getByText('Change tabs'));
    expect(orchestrationState.read).not.toHaveBeenCalled();
  });

  it('restores focus to a usable tab when the menu opener disappears', async () => {
    render(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    fireEvent.contextMenu(screen.getByText('Tab one'));
    const menuButton = screen.getByText('Expand from menu');
    menuButton.focus();
    fireEvent.click(menuButton);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(document.querySelector('[data-tab-id="tab-one"]')).toHaveFocus());
  });

  it('closes only the narrow tree popup on Escape', async () => {
    media.narrow = true;
    render(<HotkeyProvider><MaximizedWindowProvider><Workspace /><MaximizedWindow /></MaximizedWindowProvider></HotkeyProvider>);
    fireEvent.click(screen.getByText('Launch'));
    const toggle = document.querySelector<HTMLButtonElement>('.maximize-tree-toggle')!;
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
    const terminal = screen.getByLabelText('terminal');
    terminal.focus();
    fireEvent.keyDown(terminal, { key: 'Escape' });
    expect(terminal).toHaveFocus();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(screen.getByRole('tree', { name: 'Open tabs' }), { key: 'Escape' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    media.narrow = false;
  });

});
