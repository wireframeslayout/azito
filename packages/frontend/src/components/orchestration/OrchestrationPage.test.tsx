import { useImperativeHandle, type Ref } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import OrchestrationPage from './OrchestrationPage';
import { WorkspaceTargetsProvider, useWorkspaceTargets } from '../../hooks/useWorkspaceTargets';

const state = vi.hoisted(() => ({ mobile: true, open: vi.fn(), add: vi.fn(), empty: false }));
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
vi.mock('../TerminalContainer', () => ({ TerminalContainer: () => null }));
vi.mock('./LinkedPanel', () => ({ LinkedPanel: ({ onExpand, addRef }: { onExpand: (window: typeof target) => void; addRef?: Ref<{ openAdd: () => void }> }) => { useImperativeHandle(addRef, () => ({ openAdd: state.add })); return <button onClick={() => onExpand(target)}>Expand</button>; } }));
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

it('opens add from the desktop panel header', () => {
  state.mobile = false; state.add.mockClear();
  render(<WorkspaceTargetsProvider><OrchestrationPage /></WorkspaceTargetsProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'linkedPanel.add' }));
  expect(state.add).toHaveBeenCalledOnce();
  state.mobile = true;
});
