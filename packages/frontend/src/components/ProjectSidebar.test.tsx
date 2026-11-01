import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectSidebar from './ProjectSidebar';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), api: vi.fn(), normalize: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate, useLocation: () => ({ pathname: '/' }), matchPath: () => null }));
vi.mock('../api/client', () => ({ api: mocks.api }));
vi.mock('../hooks/usePwaInstall', () => ({ usePwaInstall: () => ({ canInstall: false }) }));
vi.mock('../hooks/useSystemUpdate', () => ({ useSystemUpdate: () => ({ status: null }) }));
vi.mock('../hooks/useProjectRail', () => ({ useProjectRail: () => ({
  getVisibleProjects: (projects: unknown[]) => projects.slice(0, 6), pinnedIds: [], normalize: mocks.normalize, touch: vi.fn(),
}) }));
vi.mock('./UsageDropdown', () => ({ default: () => null }));
vi.mock('./notifications/NotificationBell', () => ({ default: () => null }));
vi.mock('./ProjectSearchPopover', () => ({ ProjectSearchPopover: ({ open }: { open: boolean }) => open ? <div role="dialog">Project search</div> : null }));

describe('project rail actions', () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

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

  it('opens project creation with the keyboard', async () => {
    mocks.api.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<ProjectSidebar />);
    const add = screen.getByRole('button', { name: 'search.newProject' });
    add.focus();
    await user.keyboard('{Enter}');
    expect(mocks.navigate).toHaveBeenCalledWith('/projects/new');
  });
});
