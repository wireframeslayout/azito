// Pixel icon shared palette.
// Roles are shared across the whole set so icons read as one family:
// ink = outline / chrome, dim = secondary detail, accent hues carry meaning
// (mint = primary/success, blue = info, amber = data/warning, rose = danger),
// each accent has a matching dark for pixel-art shading.

export const PIXEL_PALETTE = {
  ink: '#e6edf3',
  dim: '#6e7a8a',
  mint: '#00e5a0',
  mintDark: '#009a6c',
  blue: '#5b8def',
  blueDark: '#3a5fc0',
  amber: '#f0b040',
  amberDark: '#c07818',
  rose: '#f06080',
  roseDark: '#b83a58',
  light: '#ffffff',
} as const;

export type PaletteKey = keyof typeof PIXEL_PALETTE;
