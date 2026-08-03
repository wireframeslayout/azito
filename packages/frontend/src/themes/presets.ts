import type { PresetTheme, BackgroundSettings, GradientSettings } from './types';

export const AURORA_GRADIENT: GradientSettings = {
  pattern: 'aurora',
  colors: ['#ff9ac1', '#58a6ff', '#b48cff'],
  angle: 135,
  intensity: 0.5,
};

const NO_BG: BackgroundSettings = {
  scope: 'terminal',
  mode: 'none',
  imageOpacity: 0.3,
  overlay: { kind: 'none', intensity: 0.5 },
};

const AURORA_BG: BackgroundSettings = {
  scope: 'terminal',
  mode: 'gradient',
  gradient: AURORA_GRADIENT,
  imageOpacity: 0.3,
  overlay: { kind: 'none', intensity: 0.5 },
};

export const PRESET_THEMES: PresetTheme[] = [
  {
    id: 'aurora',
    name: 'Azito Aurora',
    palette: {
      background: '#0d1117', foreground: '#e6edf3', cursor: '#58a6ff',
      selectionBackground: 'rgba(88,166,255,0.3)',
      black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
      blue: '#58a6ff', magenta: '#ff9ac1', cyan: '#39c5cf', white: '#b1bac4',
      brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
      brightBlue: '#79c0ff', brightMagenta: '#ffb3d1', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
    },
    background: AURORA_BG,
    uiBorder: '#30363d',
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    palette: {
      background: '#0d1117', foreground: '#e6edf3', cursor: '#58a6ff',
      selectionBackground: 'rgba(88,166,255,0.3)',
      black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
      blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
      brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
      brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
    },
    background: NO_BG,
    uiBorder: '#30363d',
  },
  {
    id: 'dracula',
    name: 'Dracula',
    palette: {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2',
      selectionBackground: 'rgba(248,248,242,0.25)',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
      brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
    background: NO_BG,
    uiBorder: '#44475a',
  },
  {
    id: 'nord',
    name: 'Nord',
    palette: {
      background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9',
      selectionBackground: 'rgba(216,222,233,0.2)',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
      blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
    background: NO_BG,
    uiBorder: '#3b4252',
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    palette: {
      background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1',
      selectionBackground: 'rgba(147,161,161,0.2)',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#859900', brightYellow: '#b58900',
      brightBlue: '#268bd2', brightMagenta: '#6c71c4', brightCyan: '#2aa198', brightWhite: '#fdf6e3',
    },
    background: NO_BG,
    uiBorder: '#073642',
  },
  {
    id: 'monokai',
    name: 'Monokai',
    palette: {
      background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f2',
      selectionBackground: 'rgba(248,248,242,0.2)',
      black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75',
      blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
      brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75',
      brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
    },
    background: NO_BG,
    uiBorder: '#49483e',
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    palette: {
      background: '#282c34', foreground: '#abb2bf', cursor: '#528bff',
      selectionBackground: 'rgba(82,139,255,0.25)',
      black: '#3f4451', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
      blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b',
      brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
    },
    background: NO_BG,
    uiBorder: '#3e4451',
  },
];

export function findPreset(id: string): PresetTheme | undefined {
  return PRESET_THEMES.find((p) => p.id === id);
}
