const SPECIAL_KEYS: Record<string, string> = {
  'Enter': 'enter',
  'Escape': 'escape',
  'Tab': 'tab',
  'Space': 'space',
  'BSpace': 'backspace',
  'DC': 'delete',
  'IC': 'insert',
  'Up': 'up',
  'Down': 'down',
  'Left': 'left',
  'Right': 'right',
  'Home': 'home',
  'End': 'end',
  'PPage': 'pageup',
  'NPage': 'pagedown',
  'F1': 'f1', 'F2': 'f2', 'F3': 'f3', 'F4': 'f4',
  'F5': 'f5', 'F6': 'f6', 'F7': 'f7', 'F8': 'f8',
  'F9': 'f9', 'F10': 'f10', 'F11': 'f11', 'F12': 'f12',
};

const CTRL_RE = /^C-(.+)$/;
const META_RE = /^M-(.+)$/;

export function tmuxKeyToHerdr(key: string): string {
  const special = SPECIAL_KEYS[key];
  if (special) return special;

  const ctrl = CTRL_RE.exec(key);
  if (ctrl) return `ctrl+${ctrl[1].toLowerCase()}`;

  const meta = META_RE.exec(key);
  if (meta) return `alt+${meta[1].toLowerCase()}`;

  return key;
}

export function tmuxKeysToHerdr(keys: string[]): string[] {
  return keys.map(tmuxKeyToHerdr);
}
