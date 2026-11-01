import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HotkeyProvider } from '../../hooks/useHotkeys';
import { GlobalSearchProvider, useOpenGlobalSearch } from './GlobalSearch';

const mocks = vi.hoisted(() => ({ openTask: vi.fn(), openTerminal: vi.fn(), navigate: vi.fn(), fetch: vi.fn(), refresh: vi.fn(), catalogError: false, withWindow: false, role: '', muxKind: 'tmux', activity: '' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { count?: number; query?: string }) => values?.query ? `${key} ${values.query}` : values?.count == null ? key : `${key} ${values.count}` }) }));
vi.mock('../ui/WindowActivityIndicator', () => ({ BrailleSpinner: () => <span data-testid="working" />, BlockedDot: () => <span data-testid="blocked" /> }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../../hooks/useWorkspaceCatalog', () => ({ useWorkspaceCatalog: () => ({ allProjects: [{ id: 1, name: 'Alpha', windows: mocks.withWindow ? [{ id: 806, role: mocks.role, muxRef: { kind: mocks.muxKind }, ownerType: 'project', projectId: 1, serverName: 'broken', tmuxTarget: 's:1', isPrimary: true, windowType: 'terminal' }] : [] }], allTasks: [{ id: 371, projectId: 1, title: 'Search task', status: 'running' }], loading: false, error: mocks.catalogError ? new Error('failed') : null, refresh: mocks.refresh }) }));
vi.mock('../../hooks/useCrossProjectNavigation', () => ({ useCrossProjectNavigation: () => ({ openTask: mocks.openTask, openTerminal: mocks.openTerminal }) }));
vi.mock('../../hooks/useNotificationChannel', () => ({ useNotificationChannel: () => {} }));
vi.mock('../../hooks/useRecentTasks', () => ({ useRecentTasks: () => ({ openedAt: { 371: 10 } }) }));
vi.mock('../../hooks/useProjectRail', () => ({ useProjectRail: () => ({ recentIds: [1], touch: vi.fn() }) }));
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../hooks/useVirtualKeyboard', () => ({ useVirtualKeyboard: () => false }));
vi.mock('../../hooks/useActiveWindowRows', () => ({ useActiveWindowRows: () => ({ rows: mocks.activity ? [{ status: 'running', activityStatus: mocks.activity, windowId: 806, serverName: 'broken', target: 's:1' }] : [] }) }));
vi.mock('../../lib/fetchServerSessions', () => ({ fetchSessionListing: mocks.fetch, keepUnavailableKinds: (_previous: unknown, listing: { sessions: unknown[] }) => listing.sessions }));
function OpenButton() { const open = useOpenGlobalSearch(); return <button onClick={() => open()}>Open</button>; }
function setup() { return render(<HotkeyProvider><GlobalSearchProvider><OpenButton /></GlobalSearchProvider></HotkeyProvider>); }

describe('global search', () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); mocks.catalogError = false; mocks.withWindow = false; mocks.role = ''; mocks.muxKind = 'tmux'; mocks.activity = ''; });
  it('searches tasks and opens a result using the keyboard', async () => {
    setup(); fireEvent.click(screen.getByText('Open'));
    const input = screen.getByRole('combobox');
    expect(screen.queryByRole('tab', { name: /globalSearch.orchestrator/ })).toBeNull();
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
    await waitFor(() => expect(screen.getByText('globalSearch.failed')).toBeInTheDocument());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '806' } });
    expect(screen.getByRole('option')).toHaveTextContent('globalSearch.offline');
    mocks.fetch.mockResolvedValue({ sessions: [], unavailable: [] });
    fireEvent.click(screen.getByText('globalSearch.retry'));
    await waitFor(() => expect(screen.queryByText('globalSearch.failed')).toBeNull());
  });
  it('keeps windows of a listed mux online when only another mux is unavailable', async () => {
    mocks.withWindow = true;
    mocks.fetch.mockResolvedValue({ sessions: [{ name: 's', kind: 'tmux', windows: [{ index: 1, name: 'one', panes: [], ref: '', windowId: null }] }], unavailable: [{ kind: 'misao', reason: 'daemon_unreachable' }] });
    setup(); fireEvent.click(screen.getByText('Open'));
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(screen.queryByText('globalSearch.failed')).toBeNull();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '806' } });
    expect(screen.getByRole('option')).not.toHaveTextContent('globalSearch.offline');
  });
  it('warns when an unavailable mux has registered windows', async () => {
    mocks.withWindow = true; mocks.muxKind = 'misao';
    mocks.fetch.mockResolvedValue({ sessions: [], unavailable: [{ kind: 'misao', reason: 'daemon_unreachable' }] });
    setup(); fireEvent.click(screen.getByText('Open'));
    await waitFor(() => expect(screen.getByText('globalSearch.failed')).toBeInTheDocument());
  });
  it('shows blocked activity on windows without a linked task', async () => {
    mocks.withWindow = true; mocks.activity = 'blocked';
    mocks.fetch.mockResolvedValue({ sessions: [], unavailable: [] });
    setup(); fireEvent.click(screen.getByText('Open'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '806' } });
    expect(screen.getByRole('option')).toContainElement(screen.getByTestId('blocked'));
  });
  it('does not close when two spaces are typed into the search input', async () => {
    setup(); fireEvent.click(screen.getByText('Open'));
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: ' ' }); fireEvent.keyDown(input, { key: ' ' });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('shows the orchestrator category only when present and includes the missing query', async () => {
    mocks.withWindow = true; mocks.role = 'orchestrator';
    mocks.fetch.mockResolvedValue({ sessions: [], unavailable: [] });
    setup(); fireEvent.click(screen.getByText('Open'));
    expect(screen.getByRole('tab', { name: /globalSearch.orchestrator/ })).toBeTruthy();
    const input = screen.getByRole('combobox');
    expect(input).toHaveAttribute('enterkeyhint', 'search');
    fireEvent.change(input, { target: { value: 'missing-term' } });
    expect(screen.getByText(/missing-term/)).toBeTruthy();
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
