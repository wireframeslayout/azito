import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import WorkspaceLayout from './WorkspaceLayout';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./LocalMenu', () => ({ default: () => null }));
vi.mock('./MobileNavSheet', () => ({ MobileNavSheet: () => null }));
vi.mock('../../hooks/useMobileShellPortalNode', () => ({ useMobileShellPortalNode: () => null }));

const base = {
  mobile: false, sidebarMode: 'windows' as const, switchSidebarMode: vi.fn(),
  sidebarCollapsed: false, setSidebarCollapsed: vi.fn(), sidebarCollapsedEffective: false,
  sidebarWidth: 300, sidebarOpen: false, setSidebarOpen: vi.fn(),
  handleResizeMouseDown: vi.fn(), handleResizeDoubleClick: vi.fn(),
  project: null, allProjects: [], sidebarContent: null, children: <div>Main content</div>,
  dragHandlers: {}, contextMenu: null, confirmDialog: null, modals: null,
  titleData: { windowById: new Map(), taskById: new Map() },
};

describe('WorkspaceLayout right panel', () => {
  it('does not render an aside without a right panel', () => {
    render(<MemoryRouter><WorkspaceLayout {...base} /></MemoryRouter>);
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.getByText('Main content')).toBeVisible();
  });
  it('renders a supplied open panel on desktop', () => {
    render(<MemoryRouter><WorkspaceLayout {...base} rightPanel={<div>Panel content</div>} rightPanelOpen onRightPanelOpenChange={vi.fn()} /></MemoryRouter>);
    expect(screen.getByRole('complementary', { name: 'workspace:rightPanel.title' })).toBeVisible();
    expect(screen.getByText('Panel content')).toBeVisible();
  });
  it('does not render the panel on mobile', () => {
    render(<MemoryRouter><WorkspaceLayout {...base} mobile rightPanel={<div>Panel content</div>} rightPanelOpen onRightPanelOpenChange={vi.fn()} /></MemoryRouter>);
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.queryByText('Panel content')).not.toBeInTheDocument();
  });
});
