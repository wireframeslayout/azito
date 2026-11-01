// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownKeyRow } from './MarkdownKeyRow';

describe('MarkdownKeyRow', () => {
  it('inserts the selected Markdown key and a tab character', () => {
    const onInsert = vi.fn();
    render(<MarkdownKeyRow onInsert={onInsert} />);
    for (const key of ['#', '-', '`', '|', '[', ']']) fireEvent.click(screen.getByRole('button', { name: key }));
    fireEvent.click(screen.getByRole('button', { name: 'Tab' }));
    expect(onInsert.mock.calls.map(([value]) => value)).toEqual(['#', '-', '`', '|', '[', ']', '\t']);
  });
});
