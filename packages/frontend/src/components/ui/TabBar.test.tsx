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
