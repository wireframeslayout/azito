import { useCallback, useEffect, useRef, useState } from 'react';
import type { FilesBackend, FileReadResult, TextUnavailable } from './backend/FilesBackend';

type TextResult = Extract<FileReadResult, { kind: 'text' }>;

export function useTextFileDocument(backend: FilesBackend, path: string, onDirtyChange?: (dirty: boolean) => void) {
  const [document, setDocument] = useState<TextResult | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<TextUnavailable | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState<FileReadResult | null | undefined>(undefined);
  const contentRef = useRef(content);
  const documentRef = useRef(document);
  documentRef.current = document;
  const generation = useRef(0);
  const savingRef = useRef<number | null>(null);
  const dirty = document !== null && content !== document.content;
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const source = backend.source;
  const notifyRef = useRef(onDirtyChange);
  notifyRef.current = onDirtyChange;
  useEffect(() => { notifyRef.current?.(dirty); }, [dirty]);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setError(null); setUnavailable(null); setSaved(false);
    try {
      const result = await backendRef.current.read(path);
      if (generation.current !== current) return;
      if (result.kind === 'unavailable') { setDocument(null); setUnavailable(result); }
      else { setDocument(result); contentRef.current = result.content; setContent(result.content); }
      setConflict(undefined);
    } catch (err) {
      if (generation.current === current) setError(err instanceof Error ? err.message : String(err));
    } finally { if (generation.current === current) setLoading(false); }
  }, [source, path]);

  useEffect(() => { setDocument(null); setContent(''); setSaving(false); savingRef.current = null; contentRef.current = ''; void load(); return () => { generation.current++; }; }, [load]);
  const change = useCallback((value: string) => { contentRef.current = value; setContent(value); setSaved(false); }, []);
  const save = useCallback(async (force = false) => {
    if (!document || savingRef.current !== null) return;
    const current = generation.current;
    const snapshot = contentRef.current;
    savingRef.current = current; setSaving(true); setError(null);
    try {
      const result = await backendRef.current.save(path, snapshot, document.version, force);
      if (generation.current !== current) return;
      if (result.kind === 'conflict') setConflict(result.latest);
      else { setDocument({ ...document, content: snapshot, version: result.version }); setConflict(undefined); setSaved(contentRef.current === snapshot); }
    } catch (err) {
      if (generation.current === current) setError(err instanceof Error ? err.message : String(err));
    } finally { if (savingRef.current === current) savingRef.current = null; if (generation.current === current) setSaving(false); }
  }, [path, document]);
  const restore = useCallback(() => {
    if (!document || documentRef.current !== document || savingRef.current !== null) return;
    contentRef.current = document.content; setContent(document.content); setSaved(false);
  }, [document]);
  return { restore, document, content, loading, error, unavailable, saving, saved, dirty, conflict, change, save, reload: load };
}
