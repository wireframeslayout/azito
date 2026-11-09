import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TabBar } from './TabBar';

it('reports a tab double click without treating a close button as one', () => {
  const doubleClick = vi.fn();
  render(<TabBar tabs={[{ id: 'one', label: 'One' }]} activeId="one" onSelect={() => {}} onClose={() => {}} onTabDoubleClick={doubleClick} />);
  fireEvent.doubleClick(screen.getByText('One'));
  expect(doubleClick).toHaveBeenCalledWith('one');
  fireEvent.doubleClick(screen.getByText('One').parentElement!.querySelector('.icon-btn')!);
  expect(doubleClick).toHaveBeenCalledTimes(1);
});

it('allows a focused tab to be selected with the keyboard', () => {
  const select = vi.fn();
  render(<TabBar tabs={[{ id: 'one', label: 'One' }]} activeId="one" onSelect={select} />);
  const tab = screen.getByRole('tab', { name: 'One' });
  tab.focus();
  fireEvent.keyDown(tab, { key: 'Enter' });
  expect(select).toHaveBeenCalledWith('one');
});

it('exposes selected, pinned and unsaved tab state', () => {
  render(<TabBar tabs={[{ id: 'one', label: 'One', pinned: true, dirty: true }]} activeId="one" onSelect={() => {}} />);
  const tab = screen.getByRole('tab', { name: /One.*tab.pinnedState.*tab.dirtyState/ });
  expect(tab).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tablist')).toContainElement(tab);
});
