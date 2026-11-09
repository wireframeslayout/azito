import { useMemo } from 'react';
import type { BinaryFilesBackend, FilesBackend } from '../files/backend/FilesBackend';
import { decodeBase64, encodeBase64 } from '../files/backend/binaryCodec';
import { useTextFileDocument } from '../files/useTextFileDocument';

/** Reuses the text document's load, save, conflict and stale-response handling for bytes. */
export function useBinaryFileDocument(backend: BinaryFilesBackend, path: string, onDirtyChange?: (dirty: boolean) => void) {
  const adapter = useMemo<FilesBackend>(() => ({
    ...backend,
    source: backend.source,
    list: (path) => backend.list(path),
    create: (path, type) => backend.create(path, type),
    rename: (path, name) => backend.rename(path, name),
    delete: (path, type) => backend.delete(path, type),
    download: (path) => backend.download(path),
    read: async (path) => { const doc = await backend.readBinary(path); return { kind: 'text', content: encodeBase64(doc.bytes), version: doc.version, language: 'binary' }; },
    save: async (path, content, version, force) => { const result = await backend.saveBinary(path, decodeBase64(content), version, force); return result.kind === 'conflict' ? { kind: 'conflict', latest: null } : result; },
  }), [backend]);
  const document = useTextFileDocument(adapter, path, onDirtyChange);
  const bytes = useMemo(() => document.document ? decodeBase64(document.content) : null, [document.document, document.content]);
  return { ...document, bytes, changeBytes: (value: Uint8Array) => document.change(encodeBase64(value)) };
}
