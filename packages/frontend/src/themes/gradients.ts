import type { GradientSettings } from './types';

function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha.toFixed(3)})`;
}

export function buildGradientCss(gradient: GradientSettings, baseColor: string): string {
  const a = gradient.intensity * 0.36 + 0.02;
  const [c1, c2, c3] = gradient.colors;

  switch (gradient.pattern) {
    case 'linear':
      return `linear-gradient(${gradient.angle}deg, ${hexToRgba(c1, a)}, ${hexToRgba(c2, a)}), ${baseColor}`;

    case 'glow':
      return [
        `radial-gradient(90% 75% at 50% 28%, ${hexToRgba(c1, a)}, transparent 65%)`,
        `radial-gradient(120% 90% at 50% 110%, ${hexToRgba(c2, a * 0.7)}, transparent 60%)`,
        baseColor,
      ].join(', ');

    case 'mesh':
      return [
        `radial-gradient(70% 60% at 15% 20%, ${hexToRgba(c1, a)}, transparent 55%)`,
        `radial-gradient(70% 60% at 85% 25%, ${hexToRgba(c2, a)}, transparent 55%)`,
        `radial-gradient(80% 70% at 50% 95%, ${hexToRgba(c3 || c1, a)}, transparent 55%)`,
        baseColor,
      ].join(', ');

    case 'aurora':
    default:
      return [
        `radial-gradient(120% 90% at 8% 0%, ${hexToRgba(c1, a)}, transparent 55%)`,
        `radial-gradient(140% 110% at 95% 100%, ${hexToRgba(c2, a * 1.15)}, transparent 58%)`,
        `radial-gradient(80% 70% at 60% 30%, ${hexToRgba(c3 || c1, a * 0.55)}, transparent 60%)`,
        baseColor,
      ].join(', ');
  }
}

export function buildOverlayCss(
  kind: string,
  intensity: number,
  accentColor?: string,
): string {
  switch (kind) {
    case 'darken':
      return `rgba(0,0,0,${(intensity * 0.85).toFixed(2)})`;
    case 'color':
      return accentColor
        ? hexToRgba(accentColor, intensity * 0.35)
        : `rgba(0,0,0,${(intensity * 0.4).toFixed(2)})`;
    case 'gradient':
      return `linear-gradient(135deg, ${hexToRgba('#ff9ac1', intensity * 0.45)}, ${hexToRgba('#58a6ff', intensity * 0.45)})`;
    case 'vignette':
      return `radial-gradient(ellipse 90% 80% at 50% 45%, transparent 40%, rgba(0,0,0,${(intensity * 0.95).toFixed(2)}) 100%)`;
    default:
      return '';
  }
}

export const GRADIENT_COLOR_COUNT: Record<string, number> = {
  aurora: 3,
  linear: 2,
  glow: 2,
  mesh: 3,
};
