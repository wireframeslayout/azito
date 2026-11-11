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
  it('opens agent windows in chat, preserves terminal selection, and leaves non-agent windows in terminal', () => {
    const agent = renderHook(() => useWindowViewMode(57301, true, true));
    expect(agent.result.current[0]).toBe('chat');
    localStorage.setItem('azito.windowView.57302', 'terminal');
    const saved = renderHook(() => useWindowViewMode(57302, true, true));
    expect(saved.result.current[0]).toBe('terminal');
    const shell = renderHook(() => useWindowViewMode(57303, true, false));
    expect(shell.result.current[0]).toBe('terminal');
  });
  it('keeps failed writes scoped to their target window', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error(); });
    const { result, rerender } = renderHook(({ id }) => useWindowViewMode(id, true, true), { initialProps: { id: 101 } });
    act(() => result.current[1]('terminal', 102));
    expect(result.current[0]).toBe('chat');
    rerender({ id: 102 });
    expect(result.current[0]).toBe('terminal');
    const other = renderHook(() => useWindowViewMode(102, false, true));
    expect(other.result.current[0]).toBe('terminal');
    act(() => result.current[1]('chat', 102));
    expect(other.result.current[0]).toBe('chat');
  });
});
