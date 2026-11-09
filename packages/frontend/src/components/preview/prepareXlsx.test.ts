// @vitest-environment jsdom
import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { prepareXlsx } from './prepareXlsx';

it('truncates all worksheets and prevents extreme column ranges', async () => {
  const zip = new JSZip();
  zip.file('xl/worksheets/sheet1.xml', '<worksheet><cols><col min="1" max="9999999"/></cols><sheetData><row r="1"><c r="CW1"/><c r="A1"/></row><row r="5001"><c r="A5001"/></row></sheetData></worksheet>');
  zip.file('xl/worksheets/sheet2.xml', '<worksheet><sheetData><row r="6000"><c r="A6000"/></row></sheetData></worksheet>');
  const result = await prepareXlsx(await zip.generateAsync({ type: 'arraybuffer' }));
  expect(result.truncated).toBe(true);
  const output = await JSZip.loadAsync(result.data);
  const first = await output.file('xl/worksheets/sheet1.xml')!.async('string');
  expect(first).toContain('max="100"');
  expect(first).not.toContain('CW1');
  expect(first).not.toContain('A5001');
  expect(await output.file('xl/worksheets/sheet2.xml')!.async('string')).not.toContain('A6000');
});
