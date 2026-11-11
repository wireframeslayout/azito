import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { HotkeyProvider } from '../hooks/useHotkeys';
import { StatusBar } from './StatusBar';

vi.mock('../hooks/useServerStatuses', () => ({ useServerStatuses: () => ({ servers: [], serversLoaded: true }) }));
vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../hooks/useAgentActivity', () => ({ useAgentActivity: () => ({ snapshotStatus: 'ready', retrySnapshot: vi.fn() }) }));
vi.mock('../hooks/useCrossProjectNavigation', () => ({ useCrossProjectNavigation: () => ({ openTask: vi.fn(), openTerminal: vi.fn() }) }));
vi.mock('../hooks/useLookout', () => ({ useLookout: () => { const [open, setOpen] = useState(false); return { open, openDrawer: () => setOpen(true), closeDrawer: () => setOpen(false), sections: { attention: [], active: [], finished: [], counts: { attention: 0, active: 0, finished: 0, failed: 0 } } }; } }));
vi.mock('../hooks/useLookoutSummaries', () => ({ useLookoutSummaries: () => new Map() }));
vi.mock('./search/GlobalSearch', () => ({ useOpenGlobalSearch: () => vi.fn() }));
vi.mock('../hooks/useWorkspaceTargets', () => ({ useWorkspaceTargets: () => ({ focusedTargetDisplay: null }) }));
vi.mock('../hooks/useSystemUpdate', () => ({ useSystemUpdate: () => ({ status: null, startUpdate: vi.fn(), checkNow: vi.fn() }) }));
vi.mock('../hooks/useToast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../hooks/useActivityDiagnostics', () => ({ useActivityDiagnostics: () => ({ rows: [], error: null }), DIAGNOSTICS_POLL_INTERVAL_MS: 1000 }));

it('opens and closes the real drawer with the status bar button', () => {
  render(<HotkeyProvider><StatusBar servers={[]} /></HotkeyProvider>);
  const button = screen.getByRole('button', { name: 'Lookout' });
  expect(button.style.fontFamily).toBe('var(--font-mono)');
  fireEvent.click(button);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.click(button);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
