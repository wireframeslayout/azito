// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OrchestrationSidebar } from './OrchestrationSidebar';

vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
const removeRole = vi.fn();
vi.mock('../../hooks/useWindowActions', () => ({ useWindowActions: () => ({ getWindowMenuItems: () => [{ label: 'orchestration.removeRole', onClick: removeRole }], confirmDialog: null, respawnResourceWarning: null }) }));
vi.mock('../../hooks/useWorkspaceCatalog', () => ({ useWorkspaceCatalog: () => ({ allProjects: [{ id: 10, name: 'Project Alpha' }] }) }));
vi.mock('../../hooks/useAgentActivity', () => ({ useAgentActivity: () => ({ activityStatus: () => null, snapshotStatus: 'ready', retrySnapshot: vi.fn() }) }));
vi.mock('../../hooks/useOrchestrators', () => ({ useOrchestrators: () => ({ status: 'ready', refresh: vi.fn(), windows: [
  { id: 1, originProjectId: 10, parentWindowId: null, label: 'Parent', tmuxTarget: 's:p', serverName: 'local', links: { total: 0, projectIds: [], serverNames: [] } },
  { id: 2, parentWindowId: 1, label: 'Child', tmuxTarget: 's:c', serverName: 'local', links: { total: 0, projectIds: [10], serverNames: [] } },
] }) }));
vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));

describe('OrchestrationSidebar', () => {
  it('shows matching ancestors and selects a child', () => {
    const select = vi.fn();
    render(<OrchestrationSidebar onSelect={select} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Child' } });
    expect(screen.getByText(/Parent/)).toBeTruthy();
    fireEvent.click(screen.getByText(/Child/));
    expect(select).toHaveBeenCalledWith(2);
  });
  it('finds a child by linked project name', () => {
    render(<OrchestrationSidebar onSelect={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Project Alpha' } });
    expect(screen.getByText(/Parent/)).toBeTruthy();
    expect(screen.getByText(/Child/)).toBeTruthy();
  });
  it('moves focus between rows with arrow keys', () => {
    render(<OrchestrationSidebar onSelect={vi.fn()} />);
    const parent = screen.getByRole('treeitem', { name: /Parent/ });
    parent.focus();
    fireEvent.keyDown(parent, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: /Child/ }));
  });
  it('moves between parent and child with left and right', () => {
    render(<OrchestrationSidebar onSelect={vi.fn()} />);
    const parent = screen.getByRole('treeitem', { name: /Parent/ });
    const child = screen.getByRole('treeitem', { name: /Child/ });
    parent.focus();
    fireEvent.keyDown(parent, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(child);
    fireEvent.keyDown(child, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(parent);
  });
  it('opens the role action from the context menu', () => {
    render(<OrchestrationSidebar onSelect={vi.fn()} />);
    fireEvent.contextMenu(screen.getByText(/Parent/));
    fireEvent.click(screen.getAllByText('orchestration.removeRole').at(-1)!);
    expect(removeRole).toHaveBeenCalled();
  });
  it('collapses children', () => {
    render(<OrchestrationSidebar onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'orchestration.collapse' }));
    expect(screen.queryByText(/Child/)).toBeNull();
  });
});
