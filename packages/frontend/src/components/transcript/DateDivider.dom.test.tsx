import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DateDivider } from './DateDivider';

it('keeps the date in the normal flow', () => {
  render(<DateDivider label="Yesterday" />);
  expect(screen.getByText('Yesterday').parentElement).not.toHaveStyle({ position: 'sticky' });
});
