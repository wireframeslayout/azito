import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './useToast';
import jaServers from '../i18n/locales/ja/servers.json';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

let show: ReturnType<typeof useToast>['showToast'];
function Consumer() { show = useToast().showToast; return <button>outside</button>; }
function advance(ms: number) { act(() => vi.advanceTimersByTime(ms)); }
function display(message: string, actions?: { label: string; onClick: () => void }[]) {
  act(() => show(message, actions));
}
function live() { return document.querySelector('[aria-live="polite"]')!; }

describe('ToastProvider', () => {
  beforeEach(() => { vi.useFakeTimers(); render(<ToastProvider><Consumer /></ToastProvider>); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('uses code point length, with a minimum and maximum', () => {
    display('😀'); advance(3099); expect(live().textContent).toBe('😀');
    advance(1); expect(live().textContent).toBe('');
    display('x'.repeat(1000)); advance(29999); expect(live().textContent).not.toBe('');
    advance(1); expect(live().textContent).toBe('');
  });
  it('gives the local network guidance time to read', () => {
    const message = jaServers.localNetwork.guidance;
    display(message); advance(20000); expect(live().textContent).toBe(message);
    advance(Math.min(30000, 3000 + Array.from(message).length * 100) - 20000 - 1); expect(live().textContent).toBe(message);
    advance(1); expect(live().textContent).toBe('');
  });
  it('keeps actions for at least ten seconds and cancels replaced timers', () => {
    display('first'); advance(2000); display('next', [{ label: 'Undo', onClick: vi.fn() }]);
    advance(9999); expect(live().textContent).toBe('next');
    advance(1); expect(live().textContent).toBe('');
  });
  it('pauses for hover and focus, including when replaced and moving focus inside', () => {
    display('first', [{ label: 'Undo', onClick: vi.fn() }]);
    const close = screen.getByRole('button', { name: 'toast.close' });
    const toast = close.parentElement!;
    fireEvent.mouseEnter(toast); act(() => close.focus());
    display('replacement', [{ label: 'Undo', onClick: vi.fn() }]);
    advance(20000); expect(live().textContent).toBe('replacement');
    fireEvent.mouseLeave(toast); advance(20000); expect(live().textContent).toBe('replacement');
    fireEvent.blur(close, { relatedTarget: screen.getByRole('button', { name: 'Undo' }) });
    advance(20000); expect(live().textContent).toBe('replacement');
    fireEvent.blur(close, { relatedTarget: screen.getByRole('button', { name: 'outside' }) });
    advance(9999); expect(live().textContent).toBe('replacement');
    advance(1); expect(live().textContent).toBe('');
  });
  it('dismisses manually and on action, and leaves a permanent live region', () => {
    const region = live(); expect(region.getAttribute('aria-atomic')).toBe('true');
    display('hello'); expect(screen.getAllByText('hello')).toEqual([region]);
    fireEvent.click(screen.getByRole('button', { name: 'toast.close' }));
    expect(region.textContent).toBe('');
    const action = vi.fn(); display('again', [{ label: 'Undo', onClick: action }]);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(action).toHaveBeenCalledOnce(); expect(region.textContent).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('restores focus to the element preceding the toast when dismissed', () => {
    const outside = screen.getByRole('button', { name: 'outside' });
    act(() => outside.focus());
    display('hello');
    const close = screen.getByRole('button', { name: 'toast.close' });
    act(() => close.focus());
    fireEvent.click(close);
    expect(document.activeElement).toBe(outside);
  });
  it('restores focus before invoking an action, which may move it elsewhere', () => {
    const outside = screen.getByRole('button', { name: 'outside' });
    const target = document.createElement('button');
    document.body.appendChild(target);
    act(() => outside.focus());
    const action = vi.fn(() => { expect(document.activeElement).toBe(outside); target.focus(); });
    display('hello', [{ label: 'Undo', onClick: action }]);
    const undo = screen.getByRole('button', { name: 'Undo' });
    act(() => undo.focus());
    fireEvent.click(undo);
    expect(action).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(target);
    target.remove();
  });
  it('clears the timer when unmounted', () => {
    display('hello'); cleanup(); expect(vi.getTimerCount()).toBe(0);
  });
});
