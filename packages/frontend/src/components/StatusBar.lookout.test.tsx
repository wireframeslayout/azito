import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { StatusBar } from './StatusBar';
const mocks = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), openTask: vi.fn(), attention: 2 }));
vi.mock('../hooks/useAgentActivity', () => ({ useAgentActivity: () => ({ snapshotStatus: 'ready', retrySnapshot: vi.fn() }) }));
vi.mock('../hooks/useCrossProjectNavigation', () => ({ useCrossProjectNavigation: () => ({ openTask: mocks.openTask, openTerminal: vi.fn() }) }));
vi.mock('../hooks/useLookout', () => ({ useLookout: () => ({ open: false, openDrawer: mocks.open, closeDrawer: mocks.close, sections: { counts: { attention: mocks.attention } } }) }));
vi.mock('./lookout/LookoutDrawer', () => ({ LookoutDrawer: ({ onOpenItem }: { onOpenItem: (item: unknown) => void }) => <button onClick={() => onOpenItem({ primaryRow: { taskId: 42 } })}>open row</button> }));
vi.mock('./search/GlobalSearch', () => ({ useOpenGlobalSearch: () => vi.fn() }));
vi.mock('../hooks/useWorkspaceTargets', () => ({ useWorkspaceTargets: () => ({ focusedTargetDisplay: null }) }));
vi.mock('../hooks/useSystemUpdate', () => ({ useSystemUpdate: () => ({ status: null, startUpdate: vi.fn(), checkNow: vi.fn() }) }));
vi.mock('../hooks/useToast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../hooks/useActivityDiagnostics', () => ({ useActivityDiagnostics: () => ({ rows: [], error: null }), DIAGNOSTICS_POLL_INTERVAL_MS: 1000 }));
it('shows the Lookout button and attention badge and opens it', () => {
  render(<StatusBar servers={[]} />);
  const button = screen.getByRole('button', { name: /Lookout/ });
  expect(button).toHaveTextContent('2');
  fireEvent.click(button);
  expect(mocks.open).toHaveBeenCalledOnce();
});
it('keeps the Lookout button without a zero badge', () => {
  mocks.attention = 0;
  render(<StatusBar servers={[]} />);
  expect(screen.getByRole('button', { name: /Lookout/ })).not.toHaveTextContent('0');
});

it('opens a referenced task when its catalog entry is unavailable', () => {
  render(<StatusBar servers={[]} />);
  fireEvent.click(screen.getByText('open row'));
  expect(mocks.openTask).toHaveBeenCalledWith(42);
});
