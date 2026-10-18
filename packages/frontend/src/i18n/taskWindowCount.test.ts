import { describe, it, expect } from 'vitest';
import { createInstance } from 'i18next';
import enWorkspace from './locales/en/workspace.json';
import jaWorkspace from './locales/ja/workspace.json';

async function makeI18n(lng: 'en' | 'ja', resources: object) {
  const i18n = createInstance();
  await i18n.init({ lng, fallbackLng: lng, resources: { [lng]: { workspace: resources } }, defaultNS: 'workspace', interpolation: { escapeValue: false } });
  return i18n;
}

describe('SP task window chip label (workspace:windows.windowCount)', () => {
  it('en pluralizes the window count', async () => {
    const i18n = await makeI18n('en', enWorkspace);
    expect(i18n.t('windows.windowCount', { count: 1 })).toBe('1 window');
    expect(i18n.t('windows.windowCount', { count: 3 })).toBe('3 windows');
  });
  it('ja renders the window count', async () => {
    const i18n = await makeI18n('ja', jaWorkspace);
    expect(i18n.t('windows.windowCount', { count: 3 })).toBe('3ウィンドウ');
  });
  it('no longer ships the pane-count key', () => {
    expect((enWorkspace as { windows: Record<string, unknown> }).windows.paneCount).toBeUndefined();
    expect((jaWorkspace as { windows: Record<string, unknown> }).windows.paneCount).toBeUndefined();
  });
});
