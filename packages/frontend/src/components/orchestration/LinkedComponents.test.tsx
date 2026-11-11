import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AddLinkPopover } from './AddLinkPopover';
import { LinkedWindowCard } from './LinkedWindowCard';
import { HotkeyProvider } from '../../hooks/useHotkeys';
import { LinkedSnapshot } from './LinkedSnapshot';

vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
it('excludes existing and ancestor candidates and searches remaining entries', () => {
  const add = vi.fn();
  render(<HotkeyProvider><AddLinkPopover open onClose={() => {}} searchLabel="Search" emptyLabel="Empty" onAdd={add} excludedWindowIds={[1]} linkedTargets={[{ taskId: 2 }]} candidates={[{ key: 'a', group: 'Project', label: 'Ancestor', target: { targetWindowId: 1 } }, { key: 'b', group: 'Project', label: 'Linked', target: { taskId: 2 } }, { key: 'c', group: 'Project', label: 'Available', target: { taskId: 3 } }]} /></HotkeyProvider>);
  expect(screen.queryByText('Ancestor')).toBeNull(); expect(screen.queryByText('Linked')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Available' })); expect(add).toHaveBeenCalledWith({ taskId: 3 });
  fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: 'missing' } }); expect(screen.getByText('Empty')).toBeTruthy();
});
it('keeps card actions separate and treats window_not_found as closed', () => {
  const open = vi.fn(); const unlink = vi.fn(); const retry = vi.fn();
  render(<LinkedWindowCard title="Task" status="Attention" openLabel="Open" unlinkLabel="Unlink" onOpen={open} onUnlink={unlink} snapshot={<LinkedSnapshot snapshot={{ id: 1, content: '', activity: null, error: { code: 'window_not_found', message: 'internal' } }} loadingLabel="Loading" closedLabel="Closed" errorLabel="Error" retryLabel="Retry" onRetry={retry} />} />);
  expect(screen.getByText('Closed')).toBeTruthy(); expect(screen.queryByText('internal')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Unlink' })); expect(unlink).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled();
});
it('opens a card and hides closed snapshots', () => {
  const open = vi.fn();
  const { rerender } = render(<LinkedWindowCard title="Task" status="Running" windowId={123} openLabel="Open" unlinkLabel="Unlink" onOpen={open} onUnlink={() => {}} snapshot={<span>Snapshot</span>} />);
  const card = screen.getByRole('button', { name: 'Open' });
  expect(screen.getByText('W-123')).toBeTruthy();
  fireEvent.click(card); expect(open).toHaveBeenCalledOnce();
  rerender(<LinkedWindowCard title="Task" status="Closed" openLabel="Open" unlinkLabel="Unlink" onOpen={open} onUnlink={() => {}} closedLabel="Closed" snapshot={<span>Snapshot</span>} />);
  expect(screen.queryByText('Snapshot')).toBeNull();
  rerender(<LinkedWindowCard title="Task" status="Completed" openLabel="Open" unlinkLabel="Unlink" onOpen={open} onUnlink={() => {}} acknowledged detail="detail" snapshot={<span>Snapshot</span>} />);
  expect(screen.queryByText('Snapshot')).toBeNull(); expect(screen.queryByText('detail')).toBeNull(); expect(screen.queryByText('Unlink')).toBeNull();
});
it('uses a consistent snapshot frame for loading, error and content, and hides empty content', () => {
  const props = { loadingLabel: 'Loading', closedLabel: 'Closed', errorLabel: 'Error', retryLabel: 'Retry', onRetry: vi.fn() };
  const { container, rerender } = render(<LinkedSnapshot {...props} />);
  const frameStyle = container.firstElementChild?.getAttribute('style');
  rerender(<LinkedSnapshot {...props} snapshot={{ id: 1, content: '', activity: null, error: { code: 'failed', message: 'error' } }} />);
  expect(container.firstElementChild?.getAttribute('style')).toBe(frameStyle);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(props.onRetry).toHaveBeenCalledOnce();
  rerender(<LinkedSnapshot {...props} snapshot={{ id: 1, content: 'long content', activity: null }} />);
  expect(container.firstElementChild?.getAttribute('style')).toBe(frameStyle);
  rerender(<LinkedSnapshot {...props} snapshot={{ id: 1, content: '', activity: null }} />);
  expect(container.firstElementChild).toBeNull();
});
