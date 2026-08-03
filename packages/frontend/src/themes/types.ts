export interface TerminalPalette {
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

export type GradientPattern = 'aurora' | 'linear' | 'glow' | 'mesh';

/** 意匠: 'shade' はボーダーレス・面の梯子（既定）、'wired' は線で階層を表す旧意匠 */
export type DesignMode = 'shade' | 'wired';

export interface GradientSettings {
  pattern: GradientPattern;
  colors: string[];
  angle: number;
  intensity: number;
}

export type OverlayKind = 'none' | 'darken' | 'color' | 'blur' | 'gradient' | 'vignette';

export interface BackgroundSettings {
  scope: 'terminal' | 'app';
  mode: 'none' | 'gradient' | 'image';
  gradient?: GradientSettings;
  imageSource?: { kind: 'url'; url: string } | { kind: 'stored' };
  imageOpacity: number;
  overlay: { kind: OverlayKind; intensity: number; color?: string };
}

export interface ThemeDefinition {
  name: string;
  palette: TerminalPalette;
  background: BackgroundSettings;
  /** Workspaceスコープ時のUIボーダー色。未指定時は palette から導出 */
  uiBorder?: string;
}

export interface TerminalThemeStore {
  version: 1;
  global: { presetId: string; design?: DesignMode } & ThemeDefinition;
  customThemes: Record<string, ThemeDefinition>;
  projectOverrides: Record<string, string>;
}

export interface PresetTheme {
  id: string;
  name: string;
  palette: TerminalPalette;
  background: BackgroundSettings;
  uiBorder?: string;
}

export const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

export function paletteAnsiArray(p: TerminalPalette): string[] {
  return ANSI_KEYS.map((k) => p[k]);
}

