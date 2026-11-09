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

it('moves through tabs with arrows, Home and End and leaves the strip with Tab', async () => {
  const userEvent = (await import('@testing-library/user-event')).default;
  const { useState } = await import('react');
  function Controlled() {
    const [active, setActive] = useState('one');
    return <><TabBar tabs={[{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }, { id: 'three', label: 'Three' }]} activeId={active} onSelect={setActive} /><button>After</button></>;
  }
  const user = userEvent.setup();
  render(<Controlled />);
  const [one, two, three] = screen.getAllByRole('tab');
  expect(one).toHaveAttribute('tabindex', '0');
  expect(two).toHaveAttribute('tabindex', '-1');
  one.focus();
  await user.keyboard('{ArrowRight}');
  expect(two).toHaveFocus();
  expect(two).toHaveAttribute('aria-selected', 'true');
  expect(two).toHaveAttribute('tabindex', '0');
  expect(one).toHaveAttribute('tabindex', '-1');
  await user.keyboard('{End}');
  expect(three).toHaveFocus();
  await user.keyboard('{Home}');
  expect(one).toHaveFocus();
  await user.keyboard('{ArrowLeft}');
  expect(three).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('tablist')).not.toContainElement(document.activeElement as HTMLElement);
  await user.tab();
  expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
});
