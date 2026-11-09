import { describe, expect, it } from 'vitest';
import { parseCsv, serializeCsv } from './csvCodec';

describe('CSV codec', () => {
  it('preserves UTF-8 BOM, delimiter, quoting and newlines', async () => {
    const bytes = new TextEncoder().encode('\ufeffone;"two;three"\r\nfour;five');
    const result = await parseCsv(bytes);
    expect(result.delimiter).toBe(';');
    expect(result.bom).toBe(true);
    expect(result.rows).toEqual([['one', 'two;three'], ['four', 'five']]);
    expect(await serializeCsv(result)).toEqual(bytes);
  });
  it('rejects invalid UTF-8 and prevents saving truncated rows', async () => {
    await expect(parseCsv(new Uint8Array([255]))).rejects.toThrow();
    const doc = await parseCsv(new TextEncoder().encode(Array.from({ length: 5001 }, (_, i) => `${i}`).join('\n')));
    expect(doc.truncated).toBe(true);
    await expect(serializeCsv(doc)).rejects.toThrow();
  });
  it('detects record newlines outside quoted multiline cells', async () => {
    const result = await parseCsv(new TextEncoder().encode('"a\nb",c\r\nd,e'));
    expect(result.newline).toBe('\r\n');
    expect(result.rows).toEqual([['a\nb', 'c'], ['d', 'e']]);
  });
});
