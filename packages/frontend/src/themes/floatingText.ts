type Rgb = [number, number, number];

function parseHex(value: string): Rgb {
  const hex = value.slice(1);
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
export function floatingTextColor(background: string, foreground: string): string {
  const base = parseHex(background), fg = parseHex(foreground);
  const elevated = mix(base, fg, 0.19), solid = mix(base, fg, 0.14);
  const black: Rgb = [0, 0, 0], white: Rgb = [255, 255, 255];
  const end = Math.min(contrast(white, elevated), contrast(white, solid)) > Math.min(contrast(black, elevated), contrast(black, solid)) ? white : black;
  const foregroundPasses = Math.min(contrast(fg, elevated), contrast(fg, solid)) >= 4.6;
  const start = foregroundPasses ? base : fg;
  const target = foregroundPasses ? fg : end;
  let low = 0, high = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2;
    const color = mix(start, target, mid);
    if (Math.min(contrast(color, elevated), contrast(color, solid)) >= 4.6) high = mid;
    else low = mid;
  }
  return `rgb(${mix(start, target, high).map(Math.round).join(', ')})`;
}
