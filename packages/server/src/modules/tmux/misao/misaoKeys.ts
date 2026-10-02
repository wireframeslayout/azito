// The key names TmuxClient.sendKeysToHandle treats as special, as the bytes a terminal sends for them.
// pane.send_keys is not implemented by the daemon (always 1005), so keys are written with pane.write.
const NAMED_KEY_BYTES: ReadonlyMap<string, string> = new Map([
  ['Enter', '\r'],
  ['Escape', '\x1b'],
  ['Tab', '\t'],
  ['Space', ' '],
  ['BSpace', '\x7f'],
  ['Up', '\x1b[A'],
  ['Down', '\x1b[B'],
  ['Right', '\x1b[C'],
  ['Left', '\x1b[D'],
  ['Home', '\x1b[H'],
  ['End', '\x1b[F'],
  ['PageUp', '\x1b[5~'],
  ['PageDown', '\x1b[6~'],
  ['M-b', '\x1bb'],
  ['M-f', '\x1bf'],
]);

const CONTROL_KEY_LETTERS = ['c', 'd', 'z', 'a', 'e', 'k', 'l', 'u', 'w', 'r'];

function controlByte(letter: string): string {
  return String.fromCharCode(letter.charCodeAt(0) & 0x1f);
}

const KEY_BYTES: ReadonlyMap<string, string> = new Map([
  ...NAMED_KEY_BYTES,
  ...CONTROL_KEY_LETTERS.map((letter): [string, string] => [`C-${letter}`, controlByte(letter)]),
]);

/** The bytes for a special key name, or undefined when `key` is not one (it is then literal text). */
export function encodeMisaoKey(key: string): string | undefined {
  return KEY_BYTES.get(key);
}
