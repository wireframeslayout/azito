import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import OrchestrationPage from './OrchestrationPage';
import { WorkspaceTargetsProvider, useWorkspaceTargets } from '../../hooks/useWorkspaceTargets';

const state = vi.hoisted(() => ({ mobile: true, open: vi.fn(), empty: false, terminal: vi.fn() }));
vi.mock('../../hooks/useMaximizedWindow', () => ({ useOptionalMaximizedWindow: () => ({ open: state.open }) }));
const target = { id: 1, serverName: 'local', tmuxTarget: 'session:1', projectId: 2, parentWindowId: null, links: { total: 0 } };
vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/orchestration/1' }), useNavigate: () => vi.fn() }));
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => state.mobile }));
vi.mock('../../hooks/useOrchestrators', () => ({ useOrchestrators: () => ({ windows: state.empty ? [] : [target], status: 'ready', refresh: vi.fn() }) }));
vi.mock('../../hooks/useAgentActivity', () => ({ useAgentActivity: () => ({ entries: [], snapshotStatus: 'ready' }) }));
vi.mock('../../hooks/useOrchestrationModel', () => ({ useOrchestrationModel: () => ({ tree: [] }) }));
vi.mock('../../hooks/useRightPanelState', () => ({ useRightPanelState: () => [true, vi.fn()] }));
vi.mock('../../hooks/useToast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('./OrchestrationCreate', () => ({ OrchestrationCreate: ({ showButton }: { showButton: boolean }) => showButton ? <button>orchestration.create</button> : null }));
vi.mock('./OrchestrationSidebar', () => ({ OrchestrationSidebar: () => null }));
vi.mock('../TerminalContainer', () => ({ TerminalContainer: (props: unknown) => { state.terminal(props); return null; } }));
vi.mock('./LinkedPanel', () => ({ LinkedPanel: ({ onExpand }: { onExpand: (window: typeof target) => void }) => <button onClick={() => onExpand(target)}>Expand</button> }));
vi.mock('../ui/BottomSheet', () => ({ BottomSheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null }));

function Controls() {
  const { linkedSheetOpen, setLinkedSheetOpen } = useWorkspaceTargets();
  return <><button onClick={() => setLinkedSheetOpen(true)}>Open sheet</button><output>{String(linkedSheetOpen)}</output></>;
}

it('closes the sheet on expansion and on page unmount', () => {
  const view = render(<WorkspaceTargetsProvider><Controls /><OrchestrationPage /></WorkspaceTargetsProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Open sheet' }));
  fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
  expect(screen.getByRole('status').textContent).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'Open sheet' }));
  view.rerender(<WorkspaceTargetsProvider><Controls /></WorkspaceTargetsProvider>);
  expect(screen.getByRole('status').textContent).toBe('false');
});

it('opens a linked window in maximize on desktop', () => {
  state.mobile = false; state.open.mockClear();
  render(<WorkspaceTargetsProvider><OrchestrationPage /></WorkspaceTargetsProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
  expect(state.open).toHaveBeenCalledWith(target.id, target);
  state.mobile = true;
});

it('offers a single create button on desktop when there are no orchestrators', () => {
  state.mobile = false; state.empty = true;
  render(<WorkspaceTargetsProvider><OrchestrationPage /></WorkspaceTargetsProvider>);
  expect(screen.getAllByRole('button', { name: 'orchestration.create' })).toHaveLength(1);
  state.mobile = true; state.empty = false;
});

it('passes the selected window and controlled view mode to the terminal', () => {
  state.mobile = false; state.terminal.mockClear();
  render(<WorkspaceTargetsProvider><OrchestrationPage /></WorkspaceTargetsProvider>);
  expect(state.terminal).toHaveBeenLastCalledWith(expect.objectContaining({ registeredWindow: { id: 1 }, viewMode: 'terminal', onViewModeChange: expect.any(Function) }));
  expect(screen.getByRole('tab', { name: 'terminal.viewMode.chat' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'terminal.viewMode.chat' }));
  expect(state.terminal).toHaveBeenLastCalledWith(expect.objectContaining({ viewMode: 'chat' }));
  state.mobile = true;
});
