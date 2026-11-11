import { describe, expect, it } from 'vitest';
import { PRESET_THEMES } from './presets';
import { floatingTextColor, FLOATING_SURFACE_MIX as mixes } from './floatingText';
import { pickUiAccent } from '../hooks/useTerminalTheme';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../styles/global.css', import.meta.url), 'utf8');

function rgb(hex: string): number[] {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}
function luminance(color: number[]): number {
  return color.reduce((sum, v, i) => {
    const c = v / 255;
    return sum + (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i];
  }, 0);
}
function ratio(a: number[], b: number[]): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('floatingTextColor', () => {
  it('accepts short hex colors and leaves other CSS colors to the CSS token', () => {
    expect(floatingTextColor('#fff', '#222', '#abc')).toBe(floatingTextColor('#ffffff', '#222222', '#aabbcc'));
    expect(floatingTextColor(' #ffffff ', ' #222222 ', ' #aabbcc ')).toBe(floatingTextColor('#ffffff', '#222222', '#aabbcc'));
    expect(floatingTextColor('white', 'black', '#000')).toBeNull();
  });
  const defaultBase = css.match(/--surface-base:\s*(#[\da-f]{6})/i)![1];
  const defaultFg = css.match(/--surface-fg:\s*(#[\da-f]{6})/i)![1];
  it.each(PRESET_THEMES)('$name: app and terminal surfaces stay readable', ({ palette }) => {
    const accent = pickUiAccent(palette);
    for (const [background, foreground] of [[palette.background, palette.foreground], [defaultBase, defaultFg]]) {
      const text = floatingTextColor(background, foreground, accent)!.match(/\d+/g)!.map(Number);
      const base = rgb(background), fg = rgb(foreground), accentRgb = rgb(accent);
      const mix = (a: number[], b: number[], amount: number) => a.map((v, i) => v * (1 - amount) + b[i] * amount);
      const elevated = mix(base, fg, mixes.elevated);
      const surfaces = [mix(base, fg, mixes.solid), elevated, mix(elevated, fg, mixes.hover), mix(elevated, accentRgb, mixes.accent)];
      for (const surface of surfaces) expect(ratio(text, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('keeps a light palette readable', () => {
    const text = floatingTextColor('#ffffff', '#222222', '#0055aa')!.match(/\d+/g)!.map(Number);
    const elevated = [255, 255, 255].map(v => v * (1 - mixes.elevated) + 34 * mixes.elevated);
    const highlighted = elevated.map((v, i) => v * (1 - mixes.accent) + [0, 85, 170][i] * mixes.accent);
    expect(ratio(text, highlighted)).toBeGreaterThanOrEqual(4.5);
  });
});
