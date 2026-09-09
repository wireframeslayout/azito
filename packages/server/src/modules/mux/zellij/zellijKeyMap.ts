export type ZellijKeyAction =
  | { type: 'chars'; value: string }
  | { type: 'bytes'; values: number[] };

const SPECIAL_KEYS: Record<string, number[]> = {
  'Enter': [13],
  'Escape': [27],
  'Tab': [9],
  'Space': [32],
  'BSpace': [127],
  'DC': [27, 91, 51, 126],
  'IC': [27, 91, 50, 126],
  'Up': [27, 91, 65],
  'Down': [27, 91, 66],
  'Right': [27, 91, 67],
  'Left': [27, 91, 68],
  'Home': [27, 91, 72],
  'End': [27, 91, 70],
  'PPage': [27, 91, 53, 126],
  'NPage': [27, 91, 54, 126],
  'F1': [27, 79, 80],
  'F2': [27, 79, 81],
  'F3': [27, 79, 82],
  'F4': [27, 79, 83],
  'F5': [27, 91, 49, 53, 126],
  'F6': [27, 91, 49, 55, 126],
  'F7': [27, 91, 49, 56, 126],
  'F8': [27, 91, 49, 57, 126],
  'F9': [27, 91, 50, 48, 126],
  'F10': [27, 91, 50, 49, 126],
  'F11': [27, 91, 50, 51, 126],
  'F12': [27, 91, 50, 52, 126],
};

const CTRL_RE = /^C-(.+)$/;
const META_RE = /^M-(.+)$/;

export function tmuxKeyToZellij(key: string): ZellijKeyAction {
  const special = SPECIAL_KEYS[key];
  if (special) return { type: 'bytes', values: special };

  const ctrl = CTRL_RE.exec(key);
  if (ctrl) {
    const ch = ctrl[1].toLowerCase();
    if (ch.length === 1 && ch >= 'a' && ch <= 'z') {
      return { type: 'bytes', values: [ch.charCodeAt(0) - 96] };
    }
    return { type: 'bytes', values: [ch.charCodeAt(0)] };
  }

  const meta = META_RE.exec(key);
  if (meta) {
    const ch = meta[1];
    return { type: 'bytes', values: [27, ch.charCodeAt(0)] };
  }

  return { type: 'chars', value: key };
}

export function tmuxKeysToZellij(keys: string[]): ZellijKeyAction[] {
  return keys.map(tmuxKeyToZellij);
}
