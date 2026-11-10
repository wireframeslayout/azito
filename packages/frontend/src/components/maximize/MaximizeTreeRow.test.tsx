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

it('gives a parent window its own accessible name without descendant names', () => {
  const row = { kind: 'window', key: 'window:1', window: { id: 1, label: 'Parent', tmuxTarget: 'parent' }, children: [{ kind: 'window', key: 'window:2', window: { id: 2, label: 'Child', tmuxTarget: 'child' }, children: [] }] } as unknown as Row;
  render(<div role="tree"><MaximizeTreeRow row={row} expanded={new Set(['window:1'])} focused="window:1" selected={1} onFocus={vi.fn()} onSelect={vi.fn()} onToggle={vi.fn()} /></div>);
  expect(screen.getByRole('treeitem', { name: /^Parent$/ })).toBeInTheDocument();
  expect(screen.getByRole('treeitem', { name: /Child/ })).toBeInTheDocument();
});

it.each(['auto', 'user'] as const)('keeps the registered name in the %s maximize tree row', labelSource => {
  const row = { kind: 'window', key: 'window:1', window: { id: 1, label: 'Registered', labelSource, tmuxTarget: 's:1' }, children: [] } as unknown as Row;
  render(<div role="tree"><MaximizeTreeRow row={row} expanded={new Set()} focused="window:1" selected={1} onFocus={vi.fn()} onSelect={vi.fn()} onToggle={vi.fn()} /></div>);
  expect(screen.getByRole('treeitem')).toHaveTextContent('Registered');
  expect(screen.getByRole('treeitem')).toHaveTextContent('W-1');
});
