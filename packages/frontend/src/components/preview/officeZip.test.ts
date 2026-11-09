import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { inspectOfficeZip, OFFICE_ZIP_LIMITS } from './officeZip';

async function archive(files: Record<string, Uint8Array | string>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(files)) zip.file(name, value);
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}

describe('inspectOfficeZip', () => {
  it('accepts a valid archive and rejects corrupt input', async () => {
    expect((await inspectOfficeZip(await archive({ 'ppt/presentation.xml': '<presentation/>' }))).file('ppt/presentation.xml')).not.toBeNull();
    await expect(inspectOfficeZip(new Uint8Array([1, 2, 3]).buffer)).rejects.toThrow();
  });
  it('rejects a changed entry even if its compressed length is intact', async () => {
    const zip = new JSZip();
    zip.file('document.xml', 'unique-text');
    const bytes = new Uint8Array(await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' }));
    const needle = new TextEncoder().encode('unique-text');
    const offset = bytes.findIndex((_, i) => needle.every((value, j) => bytes[i + j] === value));
    expect(offset).toBeGreaterThan(0);
    bytes[offset] ^= 1;
    await expect(inspectOfficeZip(bytes.buffer)).rejects.toThrow('checksum');
  });
  it('rejects an entry that expands past the limit', async () => {
    const zip = await archive({ 'large.xml': new Uint8Array(OFFICE_ZIP_LIMITS.entryBytes + 1) });
    await expect(inspectOfficeZip(zip)).rejects.toThrow('size limit');
  });
  it('counts actual bytes even when the central directory understates them', async () => {
    const zip = await archive({ 'large.xml': new Uint8Array(OFFICE_ZIP_LIMITS.entryBytes + 1) });
    const view = new DataView(zip);
    for (let offset = 0; offset < zip.byteLength - 46; offset++) {
      if (view.getUint32(offset, true) === 0x02014b50) { view.setUint32(offset + 24, 1, true); break; }
    }
    await expect(inspectOfficeZip(zip)).rejects.toThrow('size limit');
  });
  it('rejects an archive whose combined expansion exceeds the limit', async () => {
    const chunk = new Uint8Array(OFFICE_ZIP_LIMITS.entryBytes);
    const zip = await archive({ a: chunk, b: chunk, c: chunk, d: chunk });
    await expect(inspectOfficeZip(zip)).rejects.toThrow('size limit');
  }, 20_000);
  it('rejects too many entries', async () => {
    const zip = new JSZip();
    for (let i = 0; i <= OFFICE_ZIP_LIMITS.entries; i++) zip.file(`${i}`, '');
    await expect(inspectOfficeZip(await zip.generateAsync({ type: 'arraybuffer' }))).rejects.toThrow('too many entries');
  });
  it('counts central-directory records even when the declared count is falsified', async () => {
    const zip = new JSZip();
    for (let i = 0; i <= OFFICE_ZIP_LIMITS.entries; i++) zip.file(`${i}`, '');
    const data = await zip.generateAsync({ type: 'arraybuffer' });
    const view = new DataView(data);
    const end = data.byteLength - 22;
    view.setUint16(end + 8, 1, true);
    view.setUint16(end + 10, 1, true);
    await expect(inspectOfficeZip(data)).rejects.toThrow('too many entries');
  });
});
