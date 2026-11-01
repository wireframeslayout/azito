import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWindowViewMode } from './useWindowViewMode';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe('useWindowViewMode', () => {
  it('derives the current window immediately and follows width until selected', () => {
    const { result, rerender } = renderHook(({ id, mobile }) => useWindowViewMode(id, mobile, true), { initialProps: { id: 1, mobile: true } });
    expect(result.current[0]).toBe('chat');
    rerender({ id: 1, mobile: false });
    expect(result.current[0]).toBe('terminal');
    act(() => result.current[1]('chat', 1));
    rerender({ id: 2, mobile: false });
    expect(result.current[0]).toBe('terminal');
    rerender({ id: 1, mobile: false });
    expect(result.current[0]).toBe('chat');
  });
  it('keeps failed writes scoped to their target window', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error(); });
    const { result, rerender } = renderHook(({ id }) => useWindowViewMode(id, true, true), { initialProps: { id: 1 } });
    act(() => result.current[1]('terminal', 2));
    expect(result.current[0]).toBe('chat');
    rerender({ id: 2 });
    expect(result.current[0]).toBe('terminal');
  });
});
