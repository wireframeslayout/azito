import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AddLinkPopover } from './AddLinkPopover';
import { LinkedWindowCard } from './LinkedWindowCard';
import { LinkedSnapshot } from './LinkedSnapshot';
it('excludes existing and ancestor candidates and searches remaining entries', () => {
  const add = vi.fn();
  render(<AddLinkPopover searchLabel="Search" emptyLabel="Empty" onAdd={add} excludedWindowIds={[1]} linkedTargets={[{ taskId: 2 }]} candidates={[{ key: 'a', label: 'Ancestor', target: { targetWindowId: 1 } }, { key: 'b', label: 'Linked', target: { taskId: 2 } }, { key: 'c', label: 'Available', target: { taskId: 3 } }]} />);
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
