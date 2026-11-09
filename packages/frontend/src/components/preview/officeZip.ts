import JSZip from 'jszip';

export const OFFICE_ZIP_LIMITS = { entries: 10000, entryBytes: 32 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 } as const;

interface StreamedZipObject extends JSZip.JSZipObject {
  internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
  _data: { uncompressedSize?: number };
}

/** Count actual decompressed bytes in bounded chunks before allowing a renderer to open the archive. */
function countEntry(entry: JSZip.JSZipObject, total: { bytes: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const stream = (entry as StreamedZipObject).internalStream('uint8array');
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      total.bytes += chunk.length;
      if (bytes > OFFICE_ZIP_LIMITS.entryBytes || total.bytes > OFFICE_ZIP_LIMITS.totalBytes) {
        stream.pause();
        reject(new Error('Office archive exceeds the decompressed size limit'));
      }
    }).on('error', reject).on('end', resolve).resume();
  });
}

export async function inspectOfficeZip(data: ArrayBuffer): Promise<JSZip> {
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
