// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import IssueRefChip from './IssueRefChip';

it('links a GitHub issue reference', () => {
  render(<IssueRefChip source="github" sourceRef="owner/repo#7" />);
  expect(screen.getByRole('link').getAttribute('href')).toBe('https://github.com/owner/repo/issues/7');
});

it('shows the chip without a link for a provider it cannot build a URL for', () => {
  render(<IssueRefChip source="manual" sourceRef="owner/repo#7" />);
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.getByText(/#7/)).toBeTruthy();
});

it('renders nothing for an unparseable reference', () => {
  const { container } = render(<IssueRefChip source="github" sourceRef="not-a-ref" />);
  expect(container.firstChild).toBeNull();
});
