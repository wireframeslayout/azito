import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { HotkeyProvider } from '../../hooks/useHotkeys';
import { MaximizedWindowProvider, useMaximizedWindow } from '../../hooks/useMaximizedWindow';
import { MaximizedWindow } from './MaximizedWindow';
import type { Window } from '../../pages/workspace/types';

vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../hooks/useWorkspaceCatalog', () => ({ useWorkspaceCatalog: () => ({ allTasks: [], allProjects: [], refresh: vi.fn() }) }));
vi.mock('../../hooks/useWorkspaceTargets', () => ({ useWorkspaceTargets: () => ({ onOpenTask: null }) }));
vi.mock('../../hooks/useOperationLinks', () => ({ useOperationLinks: () => ({ parents: new Map(), error: false, reload: vi.fn() }) }));
const mounts = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
vi.mock('../TerminalContainer', () => ({ TerminalContainer: ({ registeredWindow }: { registeredWindow: { id: number } }) => {
  useEffect(() => { mounts.connect(registeredWindow.id); return () => mounts.disconnect(registeredWindow.id); }, [registeredWindow.id]);
  return <div className="xterm"><textarea aria-label="terminal" /></div>;
} }));
beforeAll(() => { Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) }); });
const first = { id: 1, serverName: 'host', tmuxTarget: 'one', label: 'One' } as Window;
const second = { id: 2, serverName: 'host', tmuxTarget: 'two', label: 'Two' } as Window;
function Workspace() {
  const { setWorkspace, open } = useMaximizedWindow();
  useEffect(() => { setWorkspace({ tabs: [{ kind: 'window', windowId: 1 }, { kind: 'window', windowId: 2 }], activeWindowId: 1, activeTabId: null, windows: new Map([[1, first], [2, second]]), openWindowTab: vi.fn(), wakeWindow: vi.fn(async () => {}) }); return () => setWorkspace(null); }, [setWorkspace]);
  return <button onClick={() => open(1)}>Launch</button>;
}
describe('maximized window', () => {
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
    expect(mounts.disconnect).toHaveBeenCalledWith(2);
    await waitFor(() => expect(screen.getByText('Launch')).toHaveFocus());
  });
});
