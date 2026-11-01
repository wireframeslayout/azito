import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n from 'i18next';
import { useTabPersistence } from './useTabPersistence';

const ref = { kind: 'ref' as const, serverName: 'local', ref: JSON.stringify({ kind: 'misao', workspace: 'dev', window: 'w_01234567890123456789012345' }), pane: 1 };

describe('misao terminal tab persistence', () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18n.init({ lng: 'en', resources: { en: { units: { windowFallback: 'Window' } } } });
  });

  it('persists the ref and restores a generic label without exposing its ID', async () => {
    const first = renderHook(() => useTabPersistence('test-tabs'));
    act(() => first.result.current.connectPane(ref));
    expect(first.result.current.tabs[0].label).toBe('Window');
    await waitFor(() => expect(localStorage.getItem('test-tabs')).toContain(ref.ref.replace(/"/g, '\\"')));
    first.unmount();
    const restored = renderHook(() => useTabPersistence('test-tabs'));
    expect(restored.result.current.tabs[0].terminalRef).toEqual(ref);
    expect(restored.result.current.tabs[0].label).toBe('Window');
  });
});
