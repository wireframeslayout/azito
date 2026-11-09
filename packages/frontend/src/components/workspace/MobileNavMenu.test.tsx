// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MobileNavMenu } from './MobileNavMenu';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, opts?: { count?: number }) => key === 'workspace:orchestration.railAttention' ? `${key} ${opts?.count}` : key }) }));
describe('orchestration attention on mobile', () => {
  it.each([undefined, 0, 3])('shows only a positive attention count (%s)', (count) => {
    render(<MobileNavMenu project={null} onOpenProjectSwitch={vi.fn()} objectsCount={0} onSelectMode={vi.fn()} onNavigateGlobal={vi.fn()} onOpenSearch={vi.fn()} attentionCount={count} />);
    const row = screen.getByRole('button', { name: /projects:sidebar.orchestration/ });
    expect(within(row).queryByLabelText('workspace:orchestration.railAttention 3') !== null).toBe(count === 3);
  });
});
