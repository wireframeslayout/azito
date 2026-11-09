// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LinkedPanel } from './LinkedPanel';
vi.mock('react-i18next', async (original) => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../hooks/useOrchestrationLinks', () => ({ useOrchestrationLinks: () => ({ links: [{ id: 1, kind: 'orchestration', unlinkedAt: null, sourceWindowId: 9, taskId: 2, targetWindowId: null, resolvedTaskId: 2, resolvedWindowId: 3, lastInteractionAt: null }], loading: false, error: null, add: vi.fn(), unlink: vi.fn(), undo: vi.fn(), refresh: vi.fn() }) }));
vi.mock('../../hooks/useAgentActivity', () => ({ useAgentActivity: () => ({ entries: new Map(), snapshotStatus: 'ready' }) }));
vi.mock('../../hooks/useWorkspaceCatalog', () => ({ useWorkspaceCatalog: () => ({ allTasks: [{ id: 2, title: 'Task A', status: 'waiting_input', projectId: 1, windows: [{ id: 3, taskId: 2, projectId: 1, serverName: 'local', tmuxTarget: 'a:1', isPrimary: true }] }], allProjects: [{ id: 1, name: 'Project A' }], projectsLoaded: true, error: null, refresh: vi.fn() }) }));
vi.mock('../../hooks/useVisibleIds', () => ({ useVisibleIds: () => ({ visibleIds: new Set<number>(), register: vi.fn() }) }));
vi.mock('../../hooks/useWindowSnapshots', () => ({ useWindowSnapshots: () => ({ snapshots: new Map(), refresh: vi.fn() }) }));
vi.mock('../../hooks/useWakeWindow', () => ({ useWakeWindow: () => ({ choose: vi.fn(), dialog: null }) }));
vi.mock('../../hooks/useHotkeys', () => ({ useHotkey: vi.fn(), useOverlayStack: () => ({ id: 'overlay', isTop: true }) }));

describe('LinkedPanel', () => {
  it('classifies a linked task using the shared attention model and opens its window', () => {
    const onOpen = vi.fn();
    render(<LinkedPanel windowId={9} enabled onOpen={onOpen} onExpand={vi.fn()} onProject={vi.fn()} excludedWindowIds={[9]} children={[]} onEnter={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'linkedPanel.attention' }));
    expect(screen.getByText('Task A')).toBeTruthy();
    fireEvent.click(screen.getByText('Task A').closest('article')!);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }));
  });
});
