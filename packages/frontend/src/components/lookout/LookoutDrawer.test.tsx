import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { HotkeyProvider } from '../../hooks/useHotkeys';
import { resolveActivityTitle } from '../../lib/windowDisplay';
import { buildLookoutSections } from '../../lib/lookoutSummary';
import { LookoutDrawer } from './LookoutDrawer';
import { Overlay } from '../ui/Overlay';
import type { LookoutItem } from '../../lib/lookoutSummary';

afterEach(() => vi.useRealTimers());

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
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('does not intercept keyboard input or restore focus after focus leaves the drawer', () => {
  render(<Harness />);
  const trigger = screen.getByText('Launch');
  fireEvent.click(trigger);
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /close lookout/i }));
  expect(trigger).toHaveFocus();
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
  expect(screen.getAllByText('—')).toHaveLength(7);
  expect(screen.getByRole('heading', { name: /attention.*—/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /completed.*—/i })).toBeInTheDocument();
  expect(screen.queryByText(/nothing needs your attention/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/no items to display/i)).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /in progress.*—/i })).toBeInTheDocument();
  expect(screen.queryByText(/nothing is currently running/i)).not.toBeInTheDocument();
});

it.each([['auto', 'Working · W-1'], ['user', 'Registered · W-1']] as const)('keeps the %s window title in Lookout', (labelSource, expected) => {
  const input = { windowId: 1, serverName: 'local', target: 's:1', paneTitle: 'Working', paneCommand: 'bash', label: 'Registered', labelSource };
  const title = resolveActivityTitle(input, { windowById: new Map(), taskById: new Map() });
  const sections = buildLookoutSections({ rows: [{ ...input, key: 'window', status: 'running', title }], allTasks: [], lastSeenMs: 0 });
  render(<HotkeyProvider><LookoutDrawer open onClose={() => {}} sections={sections} snapshotStatus="ready" onRetry={() => {}} onOpenItem={() => {}} /></HotkeyProvider>);
  expect(screen.getByText(expected)).toBeInTheDocument();
});

it('makes the drawer inert while a modal is open and restores it afterwards', async () => {
  function LayerHarness() {
    const [modal, setModal] = useState(false);
    const sections = { attention: [], active: [], finished: [], counts: { attention: 0, active: 0, finished: 0, failed: 0 } };
    return <HotkeyProvider><button onClick={() => setModal(true)}>Open modal</button><LookoutDrawer open onClose={() => {}} sections={sections} snapshotStatus="ready" onRetry={() => {}} onOpenItem={() => {}} /><Overlay open={modal} onClose={() => setModal(false)} labelledBy="modal-title"><h2 id="modal-title">Modal</h2></Overlay></HotkeyProvider>;
  }
  render(<LayerHarness />);
  const drawer = screen.getByRole('dialog');
  fireEvent.click(screen.getByText('Open modal'));
  await waitFor(() => expect(drawer).toHaveAttribute('inert'));
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'Modal' }), { key: 'Escape' });
  await waitFor(() => expect(drawer).not.toHaveAttribute('inert'));
});


it('updates the relative time only while open and disables refresh during loading', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const sections = { attention: [], active: [], finished: [], counts: { attention: 0, active: 0, finished: 0, failed: 0 } };
  const props = { onClose: () => {}, sections, onRetry: mocks.retry, onOpenItem: () => {}, snapshotUpdatedAt: Date.now() - 30_000 };
  const { rerender, unmount } = render(<HotkeyProvider><LookoutDrawer {...props} open snapshotStatus="loading" /></HotkeyProvider>);
  expect(screen.getByRole('button', { name: /refresh/i })).toBeDisabled();
  expect(screen.getByText(/^Updated now$/i)).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(29_999));
  expect(screen.getByText(/^Updated now$/i)).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));
  rerender(<HotkeyProvider><LookoutDrawer {...props} open snapshotStatus="ready" /></HotkeyProvider>);
  expect(screen.getByText(/1m ago/i)).toBeInTheDocument();
  rerender(<HotkeyProvider><LookoutDrawer {...props} open={false} snapshotStatus="ready" /></HotkeyProvider>);
  expect(vi.getTimerCount()).toBe(0);
  unmount();
});
