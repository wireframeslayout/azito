import JSZip from 'jszip';

export const OFFICE_ZIP_LIMITS = { entries: 10000, entryBytes: 32 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 } as const;

interface StreamedZipObject extends JSZip.JSZipObject {
  internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
  _data: { uncompressedSize?: number; crc32?: number };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

function checkDirectory(data: ArrayBuffer): void {
  const view = new DataView(data);
  let end = -1;
  for (let offset = view.byteLength - 22; offset >= Math.max(0, view.byteLength - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === view.byteLength) { end = offset; break; }
  }
  if (end < 0) throw new Error('Invalid Office archive directory');
  const declared = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const start = view.getUint32(end + 16, true);
  if (declared === 0xffff || start === 0xffffffff || size === 0xffffffff || declared > OFFICE_ZIP_LIMITS.entries) throw new Error('Office archive contains too many entries');
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 || start + size > end) throw new Error('Invalid Office archive directory');
  let count = 0;
  for (let offset = start; offset < start + size;) {
    if (offset + 46 > start + size || view.getUint32(offset, true) !== 0x02014b50) throw new Error('Invalid Office archive directory');
    const length = 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    offset += length;
    if (offset > start + size) throw new Error('Invalid Office archive directory');
    if (++count > OFFICE_ZIP_LIMITS.entries) throw new Error('Office archive contains too many entries');
  }
  if (count !== declared) throw new Error('Invalid Office archive directory');
}

/** Count actual decompressed bytes in bounded chunks before allowing a renderer to open the archive. */
function countEntry(entry: JSZip.JSZipObject, total: { bytes: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let crc = 0xffffffff;
    const stream = (entry as StreamedZipObject).internalStream('uint8array');
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      total.bytes += chunk.length;
      if (bytes > OFFICE_ZIP_LIMITS.entryBytes || total.bytes > OFFICE_ZIP_LIMITS.totalBytes) {
        stream.pause();
        reject(new Error('Office archive exceeds the decompressed size limit'));
        return;
      }
      for (const byte of chunk) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
    }).on('error', reject).on('end', () => {
      const expected = (entry as StreamedZipObject)._data.crc32;
      if (typeof expected !== 'number' || ((crc ^ 0xffffffff) >>> 0) !== (expected >>> 0)) reject(new Error('Invalid Office archive checksum'));
      else resolve();
    }).resume();
  });
}

export async function inspectOfficeZip(data: ArrayBuffer): Promise<JSZip> {
  checkDirectory(data);
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files);
  if (entries.length > OFFICE_ZIP_LIMITS.entries) throw new Error('Office archive contains too many entries');
  const total = { bytes: 0 };
  let declaredTotal = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const declared = (entry as StreamedZipObject)._data.uncompressedSize;
    if (!Number.isSafeInteger(declared) || declared! < 0 || declared! > OFFICE_ZIP_LIMITS.entryBytes) throw new Error('Office archive exceeds the decompressed size limit');
    declaredTotal += declared!;
    if (declaredTotal > OFFICE_ZIP_LIMITS.totalBytes) throw new Error('Office archive exceeds the decompressed size limit');
    await countEntry(entry, total);
  }
  return zip;
}
