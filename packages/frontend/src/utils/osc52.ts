const OSC52_RE = /\x1b\]52;[^;]*;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/g;
const OSC52_PARTIAL_TAIL_RE = /\x1b(?:\](?:5(?:2(?:;[^;]*(?:;[A-Za-z0-9+/=]*\x1b?)?)?)?)?)?$/;
const MAX_PENDING = 65536;
const decoder = new TextDecoder();

export function createOsc52Extractor(onCopy: (text: string) => void): (chunk: string) => void {
  let pending = '';
  return (chunk: string): void => {
    const data = pending + chunk;
    pending = '';
    let lastMatchEnd = 0;
    OSC52_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = OSC52_RE.exec(data)) !== null) {
      lastMatchEnd = OSC52_RE.lastIndex;
      try {
        const decoded = decoder.decode(
          Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)),
        );
        onCopy(decoded);
      } catch {
        // invalid base64
      }
    }
    const remainder = data.slice(lastMatchEnd);
    const tail = remainder.match(OSC52_PARTIAL_TAIL_RE);
    if (tail) {
      pending = tail[0];
    } else {
      const start = remainder.lastIndexOf('\x1b]52;');
      if (start !== -1) pending = remainder.slice(start);
    }
    if (pending.length > MAX_PENDING) pending = '';
  };
}
