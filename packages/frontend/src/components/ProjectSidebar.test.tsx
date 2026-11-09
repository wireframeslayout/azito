import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectSidebar from './ProjectSidebar';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), api: vi.fn(), normalize: vi.fn(), attention: null as number | null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, opts?: { count?: number }) => key === 'workspace:orchestration.railAttention' ? `${key} ${opts?.count}` : key }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate, useLocation: () => ({ pathname: '/' }), matchPath: () => null }));
vi.mock('../api/client', () => ({ api: mocks.api }));
vi.mock('../hooks/useOrchestrationModel', () => ({ useOrchestrationModel: () => ({ attention: mocks.attention }) }));
vi.mock('../hooks/usePwaInstall', () => ({ usePwaInstall: () => ({ canInstall: false }) }));
vi.mock('../hooks/useSystemUpdate', () => ({ useSystemUpdate: () => ({ status: null }) }));
vi.mock('../hooks/useProjectRail', () => ({ useProjectRail: () => ({
  getVisibleProjects: (projects: unknown[]) => projects.slice(0, 6), pinnedIds: [], normalize: mocks.normalize, touch: vi.fn(),
}) }));
vi.mock('./UsageDropdown', () => ({ default: () => null }));
vi.mock('./ProjectSearchPopover', () => ({ ProjectSearchPopover: ({ open }: { open: boolean }) => open ? <div role="dialog">Project search</div> : null }));

describe('project rail actions', () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); mocks.attention = null; });

  it.each([0, 6, 7])('offers project creation with %i projects and preserves search', async (count) => {
    mocks.api.mockResolvedValue(Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `Project ${i + 1}` })));
    const user = userEvent.setup();
    render(<ProjectSidebar />);
    await waitFor(() => expect(mocks.normalize).toHaveBeenCalledWith(Array.from({ length: count }, (_, i) => i + 1)));
    if (count) await screen.findByTitle(`Project ${Math.min(count, 6)}`);
    const add = screen.getByRole('button', { name: 'search.newProject' });
    const more = screen.getByRole('button', { name: 'sidebar.projectMenu' });
    expect(add.nextElementSibling).toBe(more);
    await user.click(add);
    expect(mocks.navigate).toHaveBeenCalledWith('/projects/new');
    await user.click(more);
    expect(screen.getByRole('dialog')).toHaveTextContent('Project search');
  });

  it('does not animate when reduced motion is preferred', () => {
    mocks.api.mockResolvedValue([]);
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    render(<ProjectSidebar />);
    act(() => window.dispatchEvent(new Event('orchestration:moved')));
    expect(screen.getByRole('button', { name: 'projects:sidebar.orchestration' })).not.toHaveClass('orchestration-rail-pulse');
    vi.unstubAllGlobals();
  });

  it('opens project creation with the keyboard', async () => {
    mocks.api.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<ProjectSidebar />);
    const add = screen.getByRole('button', { name: 'search.newProject' });
    add.focus();
    await user.keyboard('{Enter}');
    expect(mocks.navigate).toHaveBeenCalledWith('/projects/new');
  });
  it.each([null, 0, 2])('shows the attention badge only for a positive count (%s)', (attention) => {
    mocks.attention = attention;
    mocks.api.mockResolvedValue([]);
    render(<ProjectSidebar />);
    const rail = screen.getByRole('button', { name: attention ? 'workspace:orchestration.railAttention 2' : 'projects:sidebar.orchestration' });
    expect(rail.querySelector('[aria-hidden="true"][style*="warning"]') !== null).toBe(attention === 2);
  });

});
