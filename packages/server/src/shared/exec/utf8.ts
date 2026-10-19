/** `buf` without a trailing UTF-8 sequence that was cut short (a character split by a byte limit). */
export function trimIncompleteUtf8(buf: Buffer): Buffer {
  let i = buf.length - 1;
  let continuation = 0;
  while (i >= 0 && continuation < 3 && (buf[i] & 0xc0) === 0x80) {
    i--;
    continuation++;
  }
  if (i < 0) return buf;
  const lead = buf[i];
  const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return buf.length - i < needed ? buf.subarray(0, i) : buf;
}

/** The longest prefix of `text` that is at most `maxBytes` of UTF-8 and ends on a character boundary. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf-8');
  if (bytes.length <= maxBytes) return text;
  return trimIncompleteUtf8(bytes.subarray(0, maxBytes)).toString('utf-8');
}
