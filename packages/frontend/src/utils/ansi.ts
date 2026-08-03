import type { TerminalPalette } from '../themes/types';

const DEFAULT_BASE = [
  '#000000', '#800000', '#008000', '#808000', '#000080', '#800080',
  '#008080', '#c0c0c0', '#808080', '#ff0000', '#00ff00', '#ffff00',
  '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
];

export function xterm256(n: number, palette?: TerminalPalette): string {
  if (n < 16) {
    if (palette) {
      const keys: (keyof TerminalPalette)[] = [
        'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
        'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
      ];
      return (palette[keys[n]] as string) || '#e6edf3';
    }
    return DEFAULT_BASE[n] || '#e6edf3';
  }
  if (n < 232) {
    const idx = n - 16;
    const r = Math.floor(idx / 36) * 51;
    const g = Math.floor((idx % 36) / 6) * 51;
    const b = (idx % 6) * 51;
    return `rgb(${r},${g},${b})`;
  }
  const gray = (n - 232) * 10 + 8;
  return `rgb(${gray},${gray},${gray})`;
}

const DEFAULT_FG: Record<string, string> = {
  '30': '#545862', '31': '#f85149', '32': '#3fb950', '33': '#d29922',
  '34': '#58a6ff', '35': '#bc8cff', '36': '#76e3ea', '37': '#e6edf3',
  '90': '#636e7b', '91': '#ff7b72', '92': '#56d364', '93': '#e3b341',
  '94': '#79c0ff', '95': '#d2a8ff', '96': '#a5d6ff', '97': '#ffffff',
};

const DEFAULT_BG: Record<string, string> = {
  '40': '#545862', '41': '#f85149', '42': '#3fb950', '43': '#d29922',
  '44': '#58a6ff', '45': '#bc8cff', '46': '#76e3ea', '47': '#e6edf3',
  '100': '#636e7b', '101': '#ff7b72', '102': '#56d364', '103': '#e3b341',
  '104': '#79c0ff', '105': '#d2a8ff', '106': '#a5d6ff', '107': '#ffffff',
};

function buildColorMaps(palette?: TerminalPalette): { fg: Record<string, string>; bg: Record<string, string> } {
  if (!palette) return { fg: DEFAULT_FG, bg: DEFAULT_BG };

  const ansi = [
    palette.black, palette.red, palette.green, palette.yellow,
    palette.blue, palette.magenta, palette.cyan, palette.white,
    palette.brightBlack, palette.brightRed, palette.brightGreen, palette.brightYellow,
    palette.brightBlue, palette.brightMagenta, palette.brightCyan, palette.brightWhite,
  ];

  const fg: Record<string, string> = {};
  const bg: Record<string, string> = {};
  for (let i = 0; i < 8; i++) {
    fg[String(30 + i)] = ansi[i];
    fg[String(90 + i)] = ansi[8 + i];
    bg[String(40 + i)] = ansi[i];
    bg[String(100 + i)] = ansi[8 + i];
  }
  return { fg, bg };
}

function stripNonSgr(text: string): string {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x1b\\|\x07)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-LN-Zabcdefghijklnpqrstuvwxyz]/g, '')
    .replace(/\x1b[^[\]m]/g, '')
    .replace(/\r/g, '');
}

export function ansiToHtml(text: string, palette?: TerminalPalette): string {
  text = stripNonSgr(text);
  const maps = buildColorMaps(palette);

  let result = '';
  let fg: string | null = null;
  let bg: string | null = null;
  let bold = false;
  let dim = false;
  let italic = false;
  let underline = false;
  let strikethrough = false;

  const parts = text.split(/(\x1b\[[0-9;]*m)/);

  for (const part of parts) {
    const m = part.match(/^\x1b\[([0-9;]*)m$/);
    if (m) {
      const codes = (m[1] || '0').split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === 0) {
          fg = null; bg = null; bold = false; dim = false;
          italic = false; underline = false; strikethrough = false;
        } else if (c === 1) bold = true;
        else if (c === 2) dim = true;
        else if (c === 3) italic = true;
        else if (c === 4) underline = true;
        else if (c === 9) strikethrough = true;
        else if (c === 22) { bold = false; dim = false; }
        else if (c === 23) italic = false;
        else if (c === 24) underline = false;
        else if (c === 29) strikethrough = false;
        else if (c === 39) fg = null;
        else if (c === 49) bg = null;
        else if (maps.fg[c]) fg = maps.fg[c];
        else if (maps.bg[c]) bg = maps.bg[c];
        else if (c === 38 && codes[i + 1] === 5) { fg = xterm256(codes[i + 2], palette); i += 2; }
        else if (c === 48 && codes[i + 1] === 5) { bg = xterm256(codes[i + 2], palette); i += 2; }
      }
      continue;
    }

    if (!part) continue;

    const escaped = part
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const styles: string[] = [];
    if (fg) styles.push(`color:${fg}`);
    if (bg) styles.push(`background:${bg}`);
    if (bold) styles.push('font-weight:bold');
    if (dim) styles.push('opacity:0.6');
    if (italic) styles.push('font-style:italic');
    if (underline) styles.push('text-decoration:underline');
    if (strikethrough) styles.push('text-decoration:line-through');

    if (styles.length) {
      result += `<span style="${styles.join(';')}">${escaped}</span>`;
    } else {
      result += escaped;
    }
  }

  return result;
}

export function trimTrailingEmpty(text: string): string {
  const lines = text.split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  return lines.join('\n');
}
