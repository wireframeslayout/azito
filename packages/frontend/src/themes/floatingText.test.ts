import { describe, expect, it } from 'vitest';
import { PRESET_THEMES } from './presets';
import { floatingTextColor } from './floatingText';

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
    expect(floatingTextColor('#fff', '#222')).toBe(floatingTextColor('#ffffff', '#222222'));
    expect(floatingTextColor('white', 'black')).toBeNull();
  });
  it.each([...PRESET_THEMES.map(({ name, palette }) => ({ name, ...palette })), { name: 'light', background: '#ffffff', foreground: '#222222' }])('$name remains readable on both surfaces', ({ background, foreground }) => {
    const text = floatingTextColor(background, foreground)!.match(/\d+/g)!.map(Number);
    const base = rgb(background), fg = rgb(foreground);
    for (const amount of [0.14, 0.19]) {
      const surface = base.map((v, i) => v * (1 - amount) + fg[i] * amount);
      expect(ratio(text, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
