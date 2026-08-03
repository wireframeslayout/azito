import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { TerminalPalette, TerminalThemeStore, ThemeDefinition, BackgroundSettings, GradientSettings, DesignMode } from '../themes/types';
import { loadStore, saveStore } from '../themes/defaults';
import { PRESET_THEMES, findPreset } from '../themes/presets';
import { buildGradientCss, buildOverlayCss } from '../themes/gradients';
import { loadImage, saveImage, deleteImage } from '../lib/imageStore';

export interface BackdropRenderInfo {
  scope: 'terminal' | 'app';
  mode: 'none' | 'gradient' | 'image';
  baseCss: string;
  imageUrl: string | null;
  imageOpacity: number;
  imageBlur: boolean;
  blurIntensity: number;
  overlayCss: string;
}

export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent?: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

interface ThemeContextValue {
  store: TerminalThemeStore;
  resolvedTheme: ThemeDefinition;
  xtermTheme: XtermTheme;
  backdrop: BackdropRenderInfo;
  ansiPalette: TerminalPalette;
  design: DesignMode;
  setDesign: (design: DesignMode) => void;
  selectPreset: (id: string) => void;
  updatePalette: (patch: Partial<TerminalPalette>) => void;
  updateUiBorder: (color: string) => void;
  updateBackground: (patch: Partial<BackgroundSettings>) => void;
  updateGradient: (patch: Partial<GradientSettings>) => void;
  setStoredImage: (file: File | null) => void;
  saveAsCustomTheme: (name: string) => void;
  deleteCustomTheme: (id: string) => void;
  setProjectOverride: (projectId: string, themeId: string | null) => void;
  setActiveProjectId: (projectId: string | null) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTerminalTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTerminalTheme must be used within TerminalThemeProvider');
  return ctx;
}

function resolveTheme(store: TerminalThemeStore, activeProjectId: string | null): ThemeDefinition {
  if (activeProjectId) {
    const overrideId = store.projectOverrides[activeProjectId];
    if (overrideId) {
      const custom = store.customThemes[overrideId];
      if (custom) return custom;
      const preset = findPreset(overrideId);
      if (preset) return { name: preset.name, palette: preset.palette, background: preset.background, uiBorder: preset.uiBorder };
    }
  }
  return store.global;
}

function paletteToXterm(palette: TerminalPalette, hasBackdrop: boolean): XtermTheme {
  return {
    ...palette,
    background: hasBackdrop ? 'rgba(0,0,0,0)' : palette.background,
  };
}

// scope はテーマ定義ではなくグローバルなレイアウト設定（プロジェクト別テーマの背景定義に潰されない）
function computeBackdrop(theme: ThemeDefinition, imageObjectUrl: string | null, scope: 'terminal' | 'app'): BackdropRenderInfo {
  const bg = theme.background;
  const palette = theme.palette;

  let baseCss = palette.background;
  if (bg.mode === 'gradient' && bg.gradient) {
    baseCss = buildGradientCss(bg.gradient, palette.background);
  }

  let imageUrl: string | null = null;
  if (bg.mode === 'image') {
    if (bg.imageSource?.kind === 'url') {
      imageUrl = bg.imageSource.url;
    } else if (bg.imageSource?.kind === 'stored') {
      imageUrl = imageObjectUrl;
    }
  }

  const overlayCss = bg.mode === 'image' && bg.overlay.kind !== 'none'
    ? buildOverlayCss(bg.overlay.kind, bg.overlay.intensity, bg.overlay.color)
    : '';

  return {
    scope,
    mode: bg.mode,
    baseCss,
    imageUrl,
    imageOpacity: bg.imageOpacity,
    imageBlur: bg.overlay.kind === 'blur',
    blurIntensity: bg.overlay.intensity,
    overlayCss,
  };
}

export function TerminalThemeProvider({ children }: { children: React.ReactNode }) {
  const [store, setStore] = useState<TerminalThemeStore>(loadStore);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [imageObjectUrl, setImageObjectUrl] = useState<string | null>(null);
  const prevUrlRef = useRef<string | null>(null);

  useEffect(() => {
    loadImage().then((blob) => {
      if (blob) {
        const url = URL.createObjectURL(blob);
        setImageObjectUrl(url);
        prevUrlRef.current = url;
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    saveStore(store);
  }, [store]);

  const resolvedTheme = useMemo(() => resolveTheme(store, activeProjectId), [store, activeProjectId]);

  // 適用範囲はグローバル設定のみを参照（プロジェクト別テーマの背景定義には scope を含めない扱い）
  const wsScope = store.global.background.scope;

  // Workspaceスコープの有効化と、クローム面ティント（--ws-surface系）のテーマ背景色への追随
  useEffect(() => {
    const root = document.documentElement;
    // Kasumi: テーマからは「基準面 (--surface-base)」「前景 (--surface-fg)」
    // 「アクセント (--surface-accent)」の3変数だけを注入し、面の梯子・透過・
    // 深さ・アクセント階調は global.css 側で color-mix 導出する。
    // テーマドリブンで色が変わっても、面の相対関係（階層設計）は CSS が保証する。
    const clear = () => {
      delete root.dataset.bgScope;
      for (const prop of ['--surface-base', '--surface-fg']) {
        root.style.removeProperty(prop);
      }
    };
    // アクセントはスコープに関係なくテーマへ追随させる:
    // cursor が有彩色（テーマの署名色）ならそれ、無彩色なら blue スロット
    root.style.setProperty('--surface-accent', pickUiAccent(resolvedTheme.palette));
    // 意匠切替: 常に値を持つため clear() 側でのクリーンアップは不要
    root.dataset.design = store.global.design ?? 'shade';
    if (wsScope === 'app') {
      root.dataset.bgScope = 'app';
      root.style.setProperty('--surface-base', resolvedTheme.palette.background);
      root.style.setProperty('--surface-fg', resolvedTheme.palette.foreground);
    } else {
      clear();
    }
    return () => {
      clear();
      root.style.removeProperty('--surface-accent');
    };
  }, [wsScope, resolvedTheme, store.global.design]);

  const hasBackdrop = resolvedTheme.background.mode !== 'none';

  const xtermTheme = useMemo(() => paletteToXterm(resolvedTheme.palette, hasBackdrop), [resolvedTheme.palette, hasBackdrop]);

  const backdrop = useMemo(() => computeBackdrop(resolvedTheme, imageObjectUrl, wsScope), [resolvedTheme, imageObjectUrl, wsScope]);

  const ansiPalette = resolvedTheme.palette;

  const selectPreset = useCallback((id: string) => {
    // 適用範囲(scope)はテーマの見た目ではなくレイアウト範囲のユーザー設定なので、テーマ切替後も保持する
    const preset = findPreset(id);
    if (preset) {
      setStore((prev) => ({
        ...prev,
        global: {
          presetId: id,
          name: preset.name,
          palette: { ...preset.palette },
          background: { ...structuredClone(preset.background), scope: prev.global.background.scope },
          uiBorder: preset.uiBorder,
        },
      }));
      return;
    }
    setStore((prev) => {
      const custom = prev.customThemes[id];
      if (!custom) return prev;
      return {
        ...prev,
        global: {
          presetId: id,
          name: custom.name,
          palette: { ...custom.palette },
          background: { ...structuredClone(custom.background), scope: prev.global.background.scope },
          uiBorder: custom.uiBorder,
        },
      };
    });
  }, []);

  const updatePalette = useCallback((patch: Partial<TerminalPalette>) => {
    setStore((prev) => ({
      ...prev,
      global: {
        ...prev.global,
        presetId: 'custom',
        palette: { ...prev.global.palette, ...patch },
      },
    }));
  }, []);

  const updateUiBorder = useCallback((color: string) => {
    setStore((prev) => ({
      ...prev,
      global: { ...prev.global, presetId: 'custom', uiBorder: color },
    }));
  }, []);

  const setDesign = useCallback((design: DesignMode) => {
    setStore((prev) => ({
      ...prev,
      global: { ...prev.global, design },
    }));
  }, []);

  const updateBackground = useCallback((patch: Partial<BackgroundSettings>) => {
    setStore((prev) => ({
      ...prev,
      global: {
        ...prev.global,
        background: { ...prev.global.background, ...patch },
      },
    }));
  }, []);

  const updateGradient = useCallback((patch: Partial<GradientSettings>) => {
    setStore((prev) => {
      const current = prev.global.background.gradient;
      return {
        ...prev,
        global: {
          ...prev.global,
          background: {
            ...prev.global.background,
            gradient: current ? { ...current, ...patch } : { pattern: 'aurora', colors: ['#ff9ac1', '#58a6ff', '#b48cff'], angle: 135, intensity: 0.5, ...patch }, // lint-allow: hex - aurora gradient default colors (mirrors themes/presets.ts)
          },
        },
      };
    });
  }, []);

  const setStoredImageCb = useCallback((file: File | null) => {
    if (file) {
      saveImage(file).then(() => {
        if (prevUrlRef.current) URL.revokeObjectURL(prevUrlRef.current);
        const url = URL.createObjectURL(file);
        prevUrlRef.current = url;
        setImageObjectUrl(url);
        setStore((prev) => ({
          ...prev,
          global: {
            ...prev.global,
            background: { ...prev.global.background, imageSource: { kind: 'stored' } },
          },
        }));
      }).catch(() => {});
    } else {
      deleteImage().then(() => {
        if (prevUrlRef.current) URL.revokeObjectURL(prevUrlRef.current);
        prevUrlRef.current = null;
        setImageObjectUrl(null);
      }).catch(() => {});
    }
  }, []);

  const saveAsCustomTheme = useCallback((name: string) => {
    const id = 'user-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    setStore((prev) => ({
      ...prev,
      global: { ...prev.global, presetId: id },
      customThemes: {
        ...prev.customThemes,
        [id]: {
          name,
          palette: { ...prev.global.palette },
          background: structuredClone(prev.global.background),
          uiBorder: prev.global.uiBorder,
        },
      },
    }));
  }, []);

  const deleteCustomTheme = useCallback((id: string) => {
    setStore((prev) => {
      const next = { ...prev, customThemes: { ...prev.customThemes }, projectOverrides: { ...prev.projectOverrides } };
      delete next.customThemes[id];
      for (const [pid, tid] of Object.entries(next.projectOverrides)) {
        if (tid === id) delete next.projectOverrides[pid];
      }
      if (next.global.presetId === id) {
        const aurora = PRESET_THEMES[0];
        next.global = {
          presetId: 'aurora',
          name: aurora.name,
          palette: { ...aurora.palette },
          background: structuredClone(aurora.background),
        };
      }
      return next;
    });
  }, []);

  const setProjectOverride = useCallback((projectId: string, themeId: string | null) => {
    setStore((prev) => {
      const overrides = { ...prev.projectOverrides };
      if (themeId) {
        overrides[projectId] = themeId;
      } else {
        delete overrides[projectId];
      }
      return { ...prev, projectOverrides: overrides };
    });
  }, []);

  const design = store.global.design ?? 'shade';

  const value = useMemo<ThemeContextValue>(() => ({
    store,
    resolvedTheme,
    xtermTheme,
    backdrop,
    ansiPalette,
    design,
    setDesign,
    selectPreset,
    updatePalette,
    updateUiBorder,
    updateBackground,
    updateGradient,
    setStoredImage: setStoredImageCb,
    saveAsCustomTheme,
    deleteCustomTheme,
    setProjectOverride,
    setActiveProjectId,
  }), [store, resolvedTheme, xtermTheme, backdrop, ansiPalette, design, setDesign, selectPreset, updatePalette, updateUiBorder, updateBackground, updateGradient, setStoredImageCb, saveAsCustomTheme, deleteCustomTheme, setProjectOverride]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}


// Kasumi: テーマの UI アクセント選定。cursor が有彩色（彩度・明度が
// アクセントとして成立する範囲）ならテーマの署名色として採用し、
// 白/グレー系カーソルのテーマでは blue スロットへフォールバックする。
function pickUiAccent(palette: { cursor: string; blue: string }): string {
  const rgb = parseHexColor(palette.cursor);
  if (rgb) {
    const { s, l } = rgbToHsl(rgb);
    if (s >= 0.3 && l >= 0.3 && l <= 0.85) return palette.cursor;
  }
  return palette.blue;
}

function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

function rgbToHsl({ r, g, b }: { r: number; g: number; b: number }): { s: number; l: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { s, l };
}
