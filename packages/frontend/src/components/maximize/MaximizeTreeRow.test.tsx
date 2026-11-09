import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MaximizeTreeRow } from './MaximizeTreeRow';
import type { MaximizeTreeRow as Row } from '../../lib/maximizeTreeModel';

it('gives a task row its own accessible name without its children', () => {
  const row = { kind: 'task', key: 'task:1', task: { id: 1, title: 'Task', status: 'running' }, windowId: 2, children: [{ kind: 'window', key: 'window:2', window: { id: 2, label: 'Worker', tmuxTarget: 'worker' }, children: [] }] } as unknown as Row;
  render(<div role="tree"><MaximizeTreeRow row={row} expanded={new Set(['task:1'])} focused="task:1" selected={2} onFocus={vi.fn()} onSelect={vi.fn()} onToggle={vi.fn()} /></div>);
  expect(screen.getByRole('treeitem', { name: /^Task$/ })).toBeInTheDocument();
  expect(screen.getByRole('treeitem', { name: /Worker/ })).toBeInTheDocument();
});
