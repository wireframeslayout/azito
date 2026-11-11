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

it('shows a linked issue only for a valid reference and highlights attention', () => {
  const { rerender, container } = render(<LinkedWindowCard title="Window" status="attention" attention source="github" sourceRef="owner/repo#123" openLabel="Open" unlinkLabel="Unlink" onUnlink={vi.fn()} />);
  expect(screen.getByRole('link').getAttribute('href')).toBe('https://github.com/owner/repo/issues/123');
  expect(container.querySelector('article')?.style.border).toContain('var(--warning)');
  rerender(<LinkedWindowCard title="Window" status="running" openLabel="Open" unlinkLabel="Unlink" onUnlink={vi.fn()} />);
  expect(screen.queryByRole('link')).toBeNull();
});
