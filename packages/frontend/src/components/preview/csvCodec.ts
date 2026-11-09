import type Papa from 'papaparse';

export interface CsvDocument { rows: string[][]; delimiter: string; newline: '\n' | '\r' | '\r\n'; bom: boolean; truncated: boolean }
function detectNewline(text: string): CsvDocument['newline'] {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted && text[i] === '\r') return text[i + 1] === '\n' ? '\r\n' : '\r';
    else if (!quoted && text[i] === '\n') return '\n';
  }
  return '\n';
}
export async function parseCsv(bytes: Uint8Array, delimiter?: string): Promise<CsvDocument> {
  const papa = (await import('papaparse')).default;
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const newline = detectNewline(text);
  const parsed = papa.parse<string[]>(text, { delimiter: delimiter ?? '', newline, skipEmptyLines: false, preview: 5001 });
  if (parsed.errors.some((error: Papa.ParseError) => error.code !== 'UndetectableDelimiter')) throw new Error('Invalid CSV');
  const truncated = parsed.data.length > 5000 || parsed.data.some((row) => row.length > 100);
  return { rows: parsed.data.slice(0, 5000).map((row) => row.slice(0, 100)), delimiter: parsed.meta.delimiter, newline, bom, truncated };
}
export async function serializeCsv(doc: CsvDocument): Promise<Uint8Array> {
  if (doc.truncated) throw new Error('Cannot save a truncated file');
  const papa = (await import('papaparse')).default;
  const text = papa.unparse(doc.rows, { delimiter: doc.delimiter, newline: doc.newline });
  return new TextEncoder().encode((doc.bom ? '\ufeff' : '') + text);
}
