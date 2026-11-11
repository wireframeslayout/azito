import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TaskPanel from './TaskPanel';
import type { Task } from '../../pages/workspace/types';

const testData = vi.hoisted(() => ({
  row: { id: 73001, taskId: 73, ownerType: 'task', serverName: 'local', tmuxTarget: 'test:1.0', windowType: 'agent', label: 'Agent window' },
}));
vi.mock('../../api/client', () => ({ api: vi.fn(async (path: string) => path === '/tasks/73' ? { id: 73, title: 'Test task', status: 'open', projectId: 1, windows: [testData.row] } : []), apiWithStatus: vi.fn() }));
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => true }));
vi.mock('../../hooks/useAgentActivity', () => ({ useAgentActivity: () => ({ entries: new Map(), windowIndicator: () => null, findFinished: () => null }) }));
vi.mock('../../hooks/useUnitTypes', () => ({ useUnitTypes: () => ({ unitTypes: [] }), findUnitType: () => undefined }));
vi.mock('../../hooks/useNotificationChannel', () => ({ useNotificationChannel: () => {} }));
vi.mock('../../hooks/useWindowActions', () => ({ useWindowActions: () => ({}) }));
vi.mock('../../hooks/useServerPath', () => ({ useServerPathApi: () => () => undefined }));
vi.mock('../../hooks/useBrowserKeepalive', () => ({ useBrowserKeepalive: () => {} }));
vi.mock('../../hooks/useMaximizedWindow', () => ({ useOptionalMaximizedWindow: () => null }));
vi.mock('../../hooks/useGlobalFocus', () => ({ useGlobalFocus: () => ({ setFocus: vi.fn() }) }));
vi.mock('../../hooks/useToast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../hooks/useConfirm', () => ({ useConfirm: () => vi.fn() }));
vi.mock('../../hooks/useServerStatuses', () => ({ useServerStatuses: () => ({ servers: [] }) }));
vi.mock('../../hooks/useWakeWindow', () => ({ useWakeWindow: () => ({ choose: vi.fn(), dialog: null }) }));
vi.mock('../transcript/transcriptStyle', () => ({ useTranscriptStyle: () => ['default', vi.fn()] }));
vi.mock('../WindowStatusDropdown', () => ({ WindowStatusDropdown: () => null, findWindow: () => null, isTaskOwnedWindow: () => false }));
vi.mock('../transcript/WindowChatPanel', () => ({ default: ({ windowId }: { windowId: number }) => <div>chat window {windowId}</div> }));
vi.mock('../XTermView', () => ({ default: () => <div>terminal window</div> }));

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear();
  localStorage.setItem('workspace-subtab-task', JSON.stringify({ 73: { layout: { type: 'pane', id: 'p1', tabIds: ['v-window:local::test:1'], activeTabId: 'v-window:local::test:1' }, focusedPaneId: 'p1' } }));
});

afterEach(() => vi.unstubAllGlobals());

it('renders the task window as chat through TerminalContainer when the window row is registered', async () => {
  const task = { id: 73, title: 'Test task', status: 'open', projectId: 1 } as Task;
  render(<TaskPanel taskId={73} tasks={[task]} allTasks={[task]} allUnits={[]} projects={[]} sessionData={{}} executeTask={vi.fn()} stopTask={vi.fn()} onRefresh={vi.fn()} />);
  expect(await screen.findByText('chat window 73001')).toBeInTheDocument();
  expect(screen.queryByText('terminal window')).not.toBeInTheDocument();
});
