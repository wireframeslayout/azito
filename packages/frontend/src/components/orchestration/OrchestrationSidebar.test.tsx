// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OrchestrationSidebar } from './OrchestrationSidebar';

vi.mock('../../hooks/useOrchestrators', () => ({ useOrchestrators: () => ({ status: 'ready', refresh: vi.fn(), windows: [
  { id: 1, parentWindowId: null, label: 'Parent', tmuxTarget: 's:p', serverName: 'local' },
  { id: 2, parentWindowId: 1, label: 'Child', tmuxTarget: 's:c', serverName: 'local' },
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
  it('collapses children', () => {
    render(<OrchestrationSidebar onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'orchestration.collapse' }));
    expect(screen.queryByText(/Child/)).toBeNull();
  });
});
