import React from 'react';
import { PIXEL_PALETTE, type PaletteKey } from './palette';
import { makeGrid, type PixelGrid } from './grid';
import { ICON_BUILDERS_24 } from './icons24';
import { ICON_BUILDERS_16 } from './icons16';

export type PixelIconName = keyof typeof ICON_BUILDERS_24;
export type PixelGridSize = 16 | 24;

export const PIXEL_ICON_NAMES = Object.keys(ICON_BUILDERS_24) as PixelIconName[];

interface PixelRun {
  x: number;
  y: number;
  w: number;
  color: PaletteKey;
}

// Merge horizontal same-color cells into one <rect> per run.
function gridToRuns(grid: PixelGrid): PixelRun[] {
  const n = grid.length;
  const runs: PixelRun[] = [];
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      const color = grid[y][x];
      if (!color) {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < n && grid[y][x + w] === color) w++;
      runs.push({ x, y, w, color });
      x += w;
    }
  }
  return runs;
}

const runCache = new Map<string, PixelRun[]>();

function getRuns(name: PixelIconName, gridSize: PixelGridSize): PixelRun[] {
  const key = `${gridSize}:${name}`;
  const cached = runCache.get(key);
  if (cached) return cached;
  const builders = gridSize === 24 ? ICON_BUILDERS_24 : ICON_BUILDERS_16;
  const grid = makeGrid(gridSize);
  builders[name](grid);
  const runs = gridToRuns(grid);
  runCache.set(key, runs);
  return runs;
}

export interface PixelIconProps {
  name: PixelIconName;
  /** Rendered size in px. Defaults to 16 (matches existing icon components). */
  size?: number;
  /** Source grid. Defaults to 16 for size < 20, otherwise 24. */
  grid?: PixelGridSize;
  /** Render every pixel in currentColor instead of the icon palette. */
  mono?: boolean;
  /** Accessible label. Omit for decorative icons (rendered aria-hidden). */
  title?: string;
  className?: string;
}

export function PixelIcon({ name, size = 16, grid, mono = false, title, className }: PixelIconProps) {
  const gridSize: PixelGridSize = grid ?? (size < 20 ? 16 : 24);
  const runs = getRuns(name, gridSize);
  // crispEdges は整数倍スケールのみ。非整数倍では1px幅の行・列が
  // 丸め落ちて欠けて見えるため、アンチエイリアス描画に切り替える。
  const isIntegerScale = size % gridSize === 0;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${gridSize} ${gridSize}`}
      shapeRendering={isIntegerScale ? 'crispEdges' : 'auto'}
      style={{ display: 'block', flexShrink: 0 }}
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {runs.map((run, i) => (
        <rect
          key={i}
          x={run.x}
          y={run.y}
          width={run.w}
          height={1}
          fill={mono ? 'currentColor' : PIXEL_PALETTE[run.color]}
        />
      ))}
    </svg>
  );
}
