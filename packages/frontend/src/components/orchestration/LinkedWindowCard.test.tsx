// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LinkedSnapshot } from './LinkedSnapshot';
import { LinkedWindowCard } from './LinkedWindowCard';

it('keeps snapshot retry above the card open target and retries without opening', () => {
  const onOpen = vi.fn();
  const onRetry = vi.fn();
  render(<LinkedWindowCard title="Window" status="running" openLabel="Open Window" unlinkLabel="Unlink" onOpen={onOpen} onUnlink={vi.fn()}
    snapshot={<LinkedSnapshot snapshot={{ id: 1, content: '', activity: null, error: { code: 'capture_failed', message: 'failed' } }} loadingLabel="Loading" errorLabel="Error" closedLabel="Closed" retryLabel="Retry" onRetry={onRetry} />} />);
  const retry = screen.getByRole('button', { name: 'Retry' });
  expect(retry.style.position).toBe('relative');
  expect(retry.style.zIndex).toBe('1');
  fireEvent.click(retry);
  expect(onRetry).toHaveBeenCalledOnce();
  expect(onOpen).not.toHaveBeenCalled();
});
