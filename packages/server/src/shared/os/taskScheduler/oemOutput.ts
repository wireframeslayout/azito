/**
 * schtasks writes to a pipe in the OEM code page (CP932 on a Japanese Windows), not UTF-8. The code page is read once from the
 * registry (ASCII output) and mapped to a WHATWG encoding label for `TextDecoder`. A page without a label is never guessed
 * as UTF-8: the text is reported as undecodable and the raw bytes are kept.
 */

/** Windows code page -> WHATWG label. Only the pages that `TextDecoder` implements (437 / 850 and the like are not among them). */
const CODE_PAGE_LABELS: Readonly<Record<number, string>> = {
  866: 'ibm866',
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
};

export type DecodedOutput = { ok: true; text: string } | { ok: false; reason: string };

function isAscii(bytes: Buffer): boolean {
  return bytes.every((b) => b < 0x80);
}

/**
 * The bytes as text in the OEM code page. Pure ASCII is exact in every supported page, so it needs no code page
 * (`codePage` is then not even asked for: pass a function). Otherwise a page without a label, or bytes that are not valid in the
 * page, give `ok: false` with the reason; the caller keeps the bytes.
 */
export async function decodeOemOutput(bytes: Buffer, getCodePage: () => Promise<number>): Promise<DecodedOutput> {
  if (isAscii(bytes)) return { ok: true, text: bytes.toString('ascii') };
  const codePage = await getCodePage();
  const label = CODE_PAGE_LABELS[codePage];
  if (label === undefined) return { ok: false, reason: `the OEM code page ${codePage} has no decoder` };
  try {
    return { ok: true, text: new TextDecoder(label, { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: `the output is not valid ${label} (OEM code page ${codePage})` };
  }
}

/** `reg query` prints `    OEMCP    REG_SZ    932`. */
export function parseOemCodePage(regOutput: string): number {
  const match = /\bOEMCP\s+REG_SZ\s+(\d+)\b/.exec(regOutput);
  if (!match) throw new Error(`Cannot read the OEM code page from: ${regOutput.trim().slice(0, 200)}`);
  return Number(match[1]);
}

/** What goes into an error message for bytes that could not be decoded: the reason and the bytes, so nothing is lost. */
export function describeUndecodable(bytes: Buffer, reason: string): string {
  return `[undecodable output: ${reason}; bytes ${bytes.subarray(0, 200).toString('hex')}${bytes.length > 200 ? '...' : ''}]`;
}
