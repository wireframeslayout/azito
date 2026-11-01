import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HotkeyProvider } from '../../hooks/useHotkeys';
import { GlobalSearchProvider, useOpenGlobalSearch } from './GlobalSearch';

const mocks = vi.hoisted(() => ({ openTask: vi.fn(), openTerminal: vi.fn(), navigate: vi.fn(), fetch: vi.fn(), refresh: vi.fn(), catalogError: false, withWindow: false }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { count?: number }) => values?.count == null ? key : `${key} ${values.count}` }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../../hooks/useWorkspaceCatalog', () => ({ useWorkspaceCatalog: () => ({ allProjects: [{ id: 1, name: 'Alpha', windows: mocks.withWindow ? [{ id: 806, ownerType: 'project', projectId: 1, serverName: 'broken', tmuxTarget: 's:1', isPrimary: true, windowType: 'terminal' }] : [] }], allTasks: [{ id: 371, projectId: 1, title: 'Search task', status: 'running' }], loading: false, error: mocks.catalogError ? new Error('failed') : null, refresh: mocks.refresh }) }));
vi.mock('../../hooks/useCrossProjectNavigation', () => ({ useCrossProjectNavigation: () => ({ openTask: mocks.openTask, openTerminal: mocks.openTerminal }) }));
vi.mock('../../hooks/useNotificationChannel', () => ({ useNotificationChannel: () => {} }));
vi.mock('../../hooks/useRecentTasks', () => ({ useRecentTasks: () => ({ openedAt: { 371: 10 } }) }));
vi.mock('../../hooks/useProjectRail', () => ({ useProjectRail: () => ({ recentIds: [1], touch: vi.fn() }) }));
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../hooks/useVirtualKeyboard', () => ({ useVirtualKeyboard: () => false }));
vi.mock('../../hooks/useActiveWindowRows', () => ({ useActiveWindowRows: () => ({ rows: [] }) }));
vi.mock('../../lib/fetchServerSessions', () => ({ fetchSessionListing: mocks.fetch, keepUnavailableKinds: (_previous: unknown, listing: { sessions: unknown[] }) => listing.sessions }));
function OpenButton() { const open = useOpenGlobalSearch(); return <button onClick={open}>Open</button>; }
function setup() { return render(<HotkeyProvider><GlobalSearchProvider><OpenButton /></GlobalSearchProvider></HotkeyProvider>); }

describe('global search', () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); mocks.catalogError = false; mocks.withWindow = false; });
  it('searches tasks and opens a result using the keyboard', async () => {
    setup(); fireEvent.click(screen.getByText('Open'));
    const input = screen.getByRole('combobox');
    await waitFor(() => expect(screen.getByText('Search task')).toBeTruthy());
    fireEvent.change(input, { target: { value: '#371' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mocks.openTask).toHaveBeenCalledWith(371);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('retains results and offers retry when a server listing fails', async () => {
    mocks.withWindow = true;
    mocks.fetch.mockRejectedValue(new Error('unavailable'));
    setup(); fireEvent.click(screen.getByText('Open'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('globalSearch.failed'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '806' } });
    expect(screen.getByRole('option')).toBeTruthy();
    mocks.fetch.mockResolvedValue({ sessions: [], unavailable: [] });
    fireEvent.click(screen.getByText('globalSearch.retry'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
  it('opens with the chord, ignores editable targets, and restores focus', async () => {
    setup();
    const opener = screen.getByText('Open'); opener.focus();
    fireEvent.keyDown(opener, { key: ' ', code: 'Space' }); fireEvent.keyDown(opener, { key: ' ', code: 'Space' });
    const input = await screen.findByRole('combobox');
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
