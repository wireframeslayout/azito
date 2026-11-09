export function decodeBase64(value: string): Uint8Array {
  const text = atob(value);
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

export function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  return btoa(chunks.join(''));
}
