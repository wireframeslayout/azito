import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useState } from 'react';
import { HotkeyProvider } from '../../hooks/useHotkeys';
import { LookoutDrawer } from './LookoutDrawer';
import type { LookoutItem } from '../../lib/lookoutSummary';

const mocks = vi.hoisted(() => ({ openTask: vi.fn(), openTerminal: vi.fn(), retry: vi.fn() }));
const row = { key: 'a', title: 'Blocked task', status: 'blocked' as const, task: { id: 5 }, hasBlocked: true, activeWindows: 1, totalWindows: 1, windowNames: [] } as unknown as LookoutItem;
const missingTaskRow = { key: 'b', title: 'Unloaded task', status: 'blocked' as const, primaryRow: { taskId: 42, serverName: 'local', target: 's:1' }, hasBlocked: true, activeWindows: 1, totalWindows: 1, windowNames: [] } as unknown as LookoutItem;
function Harness() {
  const [open, setOpen] = useState(false);
  const sections = { attention: [row, missingTaskRow], active: [], finished: [], counts: { attention: 2, active: 0, finished: 0, failed: 0 } };
  return <HotkeyProvider><button onClick={() => setOpen(true)}>Launch</button><LookoutDrawer open={open} onClose={() => setOpen(false)} sections={sections} snapshotStatus="error" onRetry={mocks.retry} onOpenItem={item => { mocks.openTask(item.task?.id ?? item.primaryRow?.taskId); setOpen(false); }} /></HotkeyProvider>;
}
it('opens with focus, retries, navigates and restores focus', async () => {
  render(<Harness />);
  const trigger = screen.getByText('Launch');
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));
  expect(mocks.retry).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText('Blocked task'));
  expect(mocks.openTask).toHaveBeenCalledWith(5);
  await waitFor(() => expect(trigger).toHaveFocus());
});
it('closes using Escape', async () => {
  render(<Harness />);
  fireEvent.click(screen.getByText('Launch'));
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('opens a task referenced by an activity row even when the catalog has not loaded it', () => {
  render(<Harness />);
  fireEvent.click(screen.getByText('Launch'));
  fireEvent.click(screen.getByText('Unloaded task'));
  expect(mocks.openTask).toHaveBeenCalledWith(42);
});

it('shows empty states and renders supplied summaries independently of counts', () => {
  const sections = { attention: [row], active: [], finished: [], counts: { attention: 1, active: 0, finished: 0, failed: 0 } };
  const { rerender } = render(<HotkeyProvider><LookoutDrawer open onClose={() => {}} sections={sections} summaries={new Map([['a', { status: 'pending' as const }]])} snapshotStatus="ready" onRetry={() => {}} onOpenItem={() => {}} /></HotkeyProvider>);
  expect(screen.getByRole('status', { name: /summary/i })).toBeInTheDocument();
  rerender(<HotkeyProvider><LookoutDrawer open onClose={() => {}} sections={sections} summaries={new Map([['a', { status: 'ready' as const, text: 'Ready summary' }]])} snapshotStatus="ready" onRetry={() => {}} onOpenItem={() => {}} /></HotkeyProvider>);
  expect(screen.getByText('Ready summary')).toBeInTheDocument();
  expect(screen.getByText(/nothing is currently running/i)).toBeInTheDocument();
  rerender(<HotkeyProvider><LookoutDrawer open onClose={() => {}} sections={{ ...sections, attention: [] }} snapshotStatus="ready" onRetry={() => {}} onOpenItem={() => {}} /></HotkeyProvider>);
  expect(screen.getByText(/nothing needs your attention/i)).toBeInTheDocument();
});

it('does not show an idle message or active count while activity is unavailable', () => {
  const sections = { attention: [], active: [], finished: [], counts: { attention: 0, active: 0, finished: 0, failed: 0 } };
  render(<HotkeyProvider><LookoutDrawer open onClose={() => {}} sections={sections} snapshotStatus="error" onRetry={() => {}} onOpenItem={() => {}} /></HotkeyProvider>);
  expect(screen.getByText('—')).toBeInTheDocument();
  expect(screen.queryByText(/nothing is currently running/i)).not.toBeInTheDocument();
});
