import type { TerminalThemeStore } from './types';
import { PRESET_THEMES } from './presets';

const STORAGE_KEY = 'azito-terminal-theme';

export function createDefaultStore(): TerminalThemeStore {
  const aurora = PRESET_THEMES[0];
  return {
    version: 1,
    global: {
      presetId: aurora.id,
      design: 'shade',
      name: aurora.name,
      palette: { ...aurora.palette },
      background: structuredClone(aurora.background),
      uiBorder: aurora.uiBorder,
    },
    customThemes: {},
    projectOverrides: {},
  };
}

export function loadStore(): TerminalThemeStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultStore();
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1) return createDefaultStore();
    const defaults = createDefaultStore();
    return {
      version: 1,
      global: {
        ...defaults.global,
        ...parsed.global,
        palette: { ...defaults.global.palette, ...parsed.global?.palette },
        background: { ...defaults.global.background, ...parsed.global?.background },
      },
      customThemes: parsed.customThemes ?? {},
      projectOverrides: parsed.projectOverrides ?? {},
    };
  } catch {
    return createDefaultStore();
  }
}

export function saveStore(store: TerminalThemeStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage full — silently skip
  }
}
