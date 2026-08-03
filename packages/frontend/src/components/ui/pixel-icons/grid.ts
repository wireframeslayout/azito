import type { PaletteKey } from './palette';

// Pixel drawing primitives.
// Grid cells hold a palette key (or null). All geometry goes through
// rect/frame so alignment and symmetry are guaranteed by arithmetic.

export type PixelGrid = (PaletteKey | null)[][];
export type IconBuilder = (g: PixelGrid) => void;

export function makeGrid(n: number): PixelGrid {
  return Array.from({ length: n }, () => Array<PaletteKey | null>(n).fill(null));
}

function setPx(g: PixelGrid, x: number, y: number, v: PaletteKey | null): void {
  const n = g.length;
  if (x >= 0 && x < n && y >= 0 && y < n) g[y][x] = v;
}

export function rect(g: PixelGrid, c: PaletteKey, x: number, y: number, w: number, h: number): void {
  for (let j = y; j < y + h; j++)
    for (let i = x; i < x + w; i++) setPx(g, i, j, c);
}

export function clearRect(g: PixelGrid, x: number, y: number, w: number, h: number): void {
  for (let j = y; j < y + h; j++)
    for (let i = x; i < x + w; i++) setPx(g, i, j, null);
}

export function frame(g: PixelGrid, c: PaletteKey, x: number, y: number, w: number, h: number, t = 2): void {
  rect(g, c, x, y, w, t);
  rect(g, c, x, y + h - t, w, t);
  rect(g, c, x, y, t, h);
  rect(g, c, x + w - t, y, t, h);
}

// Recolor the bottom-most `depth` cells of each column that match `from`.
// Cheap, consistent pixel-art shading.
export function bottomShade(g: PixelGrid, from: PaletteKey, to: PaletteKey, depth = 2): void {
  const n = g.length;
  for (let x = 0; x < n; x++) {
    let shaded = 0;
    for (let y = n - 1; y >= 0 && shaded < depth; y--) {
      if (g[y][x] === null) {
        if (shaded > 0) break;
        continue;
      }
      if (g[y][x] === from) {
        g[y][x] = to;
        shaded++;
      } else {
        break;
      }
    }
  }
}
