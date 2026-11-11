type Rgb = [number, number, number];

function parseHex(value: string): Rgb | null {
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return null;
  const raw = value.slice(1);
  const hex = raw.length === 3 ? [...raw].map((c) => c + c).join('') : raw;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  return a.map((v, i) => v + (b[i] - v) * amount) as Rgb;
}

function luminance(rgb: Rgb): number {
  return rgb.reduce((sum, channel, i) => {
    const v = channel / 255;
    return sum + (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i];
  }, 0);
}

function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** A muted theme color that remains readable on both opaque floating surfaces. */
export function floatingTextColor(background: string, foreground: string): string | null {
  const base = parseHex(background), fg = parseHex(foreground);
  if (!base || !fg) return null;
  // Keep these surface mixes in sync with global.css, including app-scope row hover.
  const elevated = mix(base, fg, 0.19), solid = mix(base, fg, 0.14);
  const surfaces = [elevated, solid, mix(elevated, fg, 0.13)];
  const minimumContrast = (color: Rgb) => Math.min(...surfaces.map(surface => contrast(color, surface)));
  const black: Rgb = [0, 0, 0], white: Rgb = [255, 255, 255];
  const end = minimumContrast(white) > minimumContrast(black) ? white : black;
  const foregroundPasses = minimumContrast(fg) >= 4.6;
  const start = foregroundPasses ? base : fg;
  const target = foregroundPasses ? fg : end;
  let low = 0, high = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2;
    const color = mix(start, target, mid);
    if (minimumContrast(color) >= 4.6) high = mid;
    else low = mid;
  }
  return `rgb(${mix(start, target, high).map(Math.round).join(', ')})`;
}
