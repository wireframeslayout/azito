import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageEntryRow } from './StorageEntryRow';

vi.mock('react-i18next', async (original) => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../hooks/useBlobUrl', () => ({ useBlobUrl: () => ({ url: null }) }));

describe('StorageEntryRow touch selection', () => {
  afterEach(() => vi.useRealTimers());
  it('handles long press only on the name, never on checkbox or action buttons', () => {
    vi.useFakeTimers();
    const toggle = vi.fn(), open = vi.fn(), download = vi.fn(), copy = vi.fn();
    render(<StorageEntryRow entry={{ name: 'a.txt', path: 'a.txt', type: 'file' }} rawPath="/a" isSelected={false} isActive={false} mobile selectionMode={false} onToggle={toggle} onRangeSelect={vi.fn()} onOpen={open} onDownload={download} onCopyUrl={copy} />);
    const touch = { touches: [{ clientX: 1, clientY: 1 }] };
    for (const target of [screen.getByRole('checkbox'), screen.getByRole('button', { name: 'storage.download' }), screen.getByRole('button', { name: 'storage.copyUrl' })]) {
      fireEvent.touchStart(target, touch); act(() => vi.advanceTimersByTime(600)); fireEvent.touchEnd(target);
    }
    expect(toggle).not.toHaveBeenCalled();
    const name = screen.getByRole('button', { name: 'a.txt' });
    fireEvent.touchStart(name, touch); act(() => vi.advanceTimersByTime(600));
    const end = new Event('touchend', { bubbles: true, cancelable: true });
    fireEvent(name, end);
    expect(end.defaultPrevented).toBe(true);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });
  it('tapping a name in mobile selection mode toggles rather than opening', () => {
    const toggle = vi.fn(), open = vi.fn();
    render(<StorageEntryRow entry={{ name: 'folder', path: 'folder/', type: 'directory' }} rawPath="/folder" isSelected={false} isActive={false} mobile selectionMode onToggle={toggle} onRangeSelect={vi.fn()} onOpen={open} onDownload={vi.fn()} onCopyUrl={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'folder' }));
    expect(toggle).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled();
  });
});
