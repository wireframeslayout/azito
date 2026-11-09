import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { handleRovingTreeKeyDown } from './useTreeKeyboard';

it('leaves Alt arrows and already handled keys to the enclosing overlay', () => {
  const toggle = vi.fn();
  function Tree() {
    const ref = useRef<HTMLDivElement>(null);
    return <div ref={ref} role="tree" onKeyDown={event => handleRovingTreeKeyDown(event, ref.current, toggle)}><div role="treeitem" tabIndex={0}>First</div><div role="treeitem" tabIndex={-1}>Second</div></div>;
  }
  render(<Tree />);
  const first = screen.getByRole('treeitem', { name: 'First' });
  first.focus();
  fireEvent.keyDown(first, { key: 'ArrowDown', altKey: true });
  expect(first).toHaveFocus();
  expect(toggle).not.toHaveBeenCalled();
});
