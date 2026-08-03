const KEY_SEQUENCES: Record<string, string> = {
  Enter: '\r',
  Escape: '\x1b',
  Tab: '\t',
  'C-c': '\x03',
  Up: '\x1b[A',
  Down: '\x1b[B',
};

/** Maps a symbolic key name to its terminal byte sequence; unknown keys pass through literally. */
export function mapKey(key: string): string {
  return KEY_SEQUENCES[key] ?? key;
}
