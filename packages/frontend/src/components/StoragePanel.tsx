import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchBlob, uploadFile } from '../api/client';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { useBlobUrl } from '../hooks/useBlobUrl';
import { BottomSheet } from './ui/BottomSheet';
import { Icon } from './ui/Icon';
import { LoadingState, EmptyState } from './ui';
import InlineNameInput from './files/InlineNameInput';
import { PathBreadcrumb } from './files/PathBreadcrumb';
import FileTree from './files/FileTree';
import type { FileEntry } from './files/backend/FilesBackend';
import { StorageFilesBackend } from './files/backend/StorageFilesBackend';
import { StorageStatusGate } from './storage/StorageStatusGate';
import { useStorageEntries } from './storage/useStorageEntries';
import { StorageMovePicker } from './storage/StorageMovePicker';
import { collectStorageDrop, uploadStorageDrop, type StorageDropItem, type StorageDropFailure } from './storage/storageDrop';

export interface StoredFile { key: string; originalName: string; size: number; lastModified: string }
interface StoragePanelProps { projectId: number; onFilePreview?: (file: StoredFile) => void; activeTabId?: string | null }
export default function StoragePanel(props: StoragePanelProps) {
  return <StorageStatusGate projectId={props.projectId}><StorageFileList key={props.projectId} {...props} /></StorageStatusGate>;
}

function StorageThumbnail({ path }: { path: string }) {
  const { url } = useBlobUrl(path);
  return url ? <img src={url} alt="" style={{ width: 28, height: 28, objectFit: 'cover', borderRadius: 'var(--radius-sm)' }} /> : <Icon name="image" size={16} />;
}

function StorageFileList({ projectId, onFilePreview, activeTabId }: StoragePanelProps) {
  const { t } = useTranslation('storage');
  const { t: filesT } = useTranslation('files');
  const { showToast } = useToast();
  const confirm = useConfirm();
  const backend = useMemo(() => new StorageFilesBackend(projectId), [projectId]);
  const [path, setPath] = useState('');
  const { entries, loading, loadingMore, error, nextCursor, loadMore, refresh } = useStorageEntries(backend, path);
  const [selected, setSelected] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState('name');
  const [editing, setEditing] = useState<FileEntry | 'create' | null>(null);
  const [moving, setMoving] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [mobile, setMobile] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(max-width: 768px)');
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState('');
  const [failures, setFailures] = useState<StorageDropFailure[]>([]);
  const [previews, setPreviews] = useState<Array<{ url: string; name: string }>>([]);
  const input = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);
  const visible = entries.filter((entry) => entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    if (sort === 'dateAsc' || sort === 'dateDesc') return (a.lastModified === undefined && b.lastModified === undefined ? 0 : a.lastModified === undefined ? 1 : b.lastModified === undefined ? -1 : (sort === 'dateAsc' ? 1 : -1) * a.lastModified.localeCompare(b.lastModified)) || a.name.localeCompare(b.name);
    if (sort === 'sizeAsc' || sort === 'sizeDesc') return (a.size === undefined && b.size === undefined ? 0 : a.size === undefined ? 1 : b.size === undefined ? -1 : (sort === 'sizeAsc' ? 1 : -1) * (a.size - b.size)) || a.name.localeCompare(b.name);
    return (sort === 'nameDesc' ? -1 : 1) * a.name.localeCompare(b.name);
  });
  const chosen = entries.filter((entry) => selected.includes(entry.path));
  useEffect(() => { if (selected.length === 0) setActionsOpen(false); }, [selected.length]);
  useEffect(() => { setSelected([]); anchor.current = null; setEditing(null); setMoving(false); setActionsOpen(false); }, [path]);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !nextCursor || error || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((observed) => { if (observed.some((item) => item.isIntersecting)) void loadMore(); });
    observer.observe(node); return () => observer.disconnect();
  }, [nextCursor, error, loadMore]);
  function select(entry: FileEntry, additive: boolean, range: boolean) {
    if (range && anchor.current) {
      const start = visible.findIndex((item) => item.path === anchor.current);
      const end = visible.findIndex((item) => item.path === entry.path);
      if (start >= 0 && end >= 0) { setSelected(visible.slice(Math.min(start, end), Math.max(start, end) + 1).map((item) => item.path)); return; }
    }
    setSelected((previous) => additive ? (previous.includes(entry.path) ? previous.filter((item) => item !== entry.path) : [...previous, entry.path]) : [entry.path]);
    anchor.current = entry.path;
  }
  function navigate(next: string) { if (busy) return; setPath(next); setFilter(''); }
  async function run(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try { await operation(); setSelected([]); await refresh(); }
    catch (err) { showToast(err instanceof Error ? err.message : t('list.operationError')); await refresh(); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!chosen.length || busy) return;
    setBusy(true);
    try {
      const stats = await Promise.all(chosen.filter((entry) => entry.type === 'directory').map((entry) => backend.stat(entry.path)));
      const count = stats.reduce((sum, item) => sum + item.count, 0);
      const size = stats.reduce((sum, item) => sum + item.totalSize, 0);
      if (await confirm({ title: t('list.deleteTitle'), message: t('list.deleteMessage', { names: chosen.map((entry) => entry.name).join(', '), count, size }), danger: true })) {
        await backend.deleteMany(chosen); setSelected([]); await refresh();
      }
    } catch (err) { showToast(err instanceof Error ? err.message : t('list.operationError')); await refresh(); }
    finally { setBusy(false); }
  }
  async function uploadItems(items: Promise<StorageDropItem[]>) {
    setBusy(true);
    setFailures([]);
    let urls: string[] = [];
    try {
      const collected = await items;
      const images = collected.filter((item) => item.type === 'file' && item.file.type.startsWith('image/')).map((item) => {
        if (item.type !== 'file') throw new Error('Invalid upload item');
        return { url: URL.createObjectURL(item.file), name: item.file.name };
      });
      urls = images.map((image) => image.url);
      setPreviews(images);
      const result = await uploadStorageDrop(collected, path, {
        createFolder: (folder) => backend.ensureFolder(folder),
        uploadFile: async (file, prefix) => {
          const response = await uploadFile<{ error?: string }>(`/projects/${projectId}/storage/upload?prefix=${encodeURIComponent(prefix)}`, file);
          if (response.error) throw new Error(response.error);
        },
        onProgress: (completed, total) => setProgress(t('list.uploadProgress', { completed, total })),
      });
      setFailures(result.failures);
    } catch (err) { showToast(err instanceof Error ? err.message : t('list.operationError')); }
    finally { urls.forEach((url) => URL.revokeObjectURL(url)); setPreviews([]); setProgress(''); await refresh(); setBusy(false); }
  }
  function isFileDrag(event: React.DragEvent) {
    return event.dataTransfer.types.includes('Files') && !event.dataTransfer.types.includes('application/x-azito-tab');
  }
  function drop(event: React.DragEvent) {
    if (!isFileDrag(event)) return;
    event.preventDefault(); event.stopPropagation(); setDragOver(false);
    if (!busy) void uploadItems(collectStorageDrop(event.dataTransfer));
  }
  function raw(entry: FileEntry) { return `/projects/${projectId}/storage/${encodeURIComponent(entry.path)}/raw`; }
  async function download(entry: FileEntry) {
    try { const blob = await fetchBlob(raw(entry)); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = entry.name; link.click(); URL.revokeObjectURL(url); }
    catch { showToast(t('list.operationError')); }
  }
  async function copyUrl(entry: FileEntry) {
    const value = `${window.location.origin}/api${raw(entry)}`;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const field = document.createElement('textarea');
        field.value = value;
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.appendChild(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        if (!copied) throw new Error('Copy failed');
      }
      showToast(filesT('storage.copiedUrl'));
    } catch { showToast(t('list.operationError')); }
  }
  function preview(entry: FileEntry) { onFilePreview?.({ key: `projects/${projectId}/${entry.path}`, originalName: entry.name, size: entry.size ?? 0, lastModified: entry.lastModified ?? '' }); }
  return <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative', minWidth: 0 }}
    onDragEnter={(event) => { if (!isFileDrag(event)) return; event.preventDefault(); event.stopPropagation(); setDragOver(true); }}
    onDragOver={(event) => { if (!isFileDrag(event)) return; event.preventDefault(); event.stopPropagation(); }}
    onDragLeave={(event) => { if (!isFileDrag(event)) return; event.stopPropagation(); if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false); }} onDrop={(event) => void drop(event)}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', padding: 'var(--space-2)' }}>
      <button type="button" disabled={busy} onClick={() => input.current?.click()}>{filesT('storage.uploadFile')}</button>
      <input ref={input} type="file" multiple hidden onChange={(event) => { void uploadItems(Promise.resolve(Array.from(event.target.files ?? []).map((file) => ({ type: 'file' as const, path: file.name, file })))); event.target.value = ''; }} />
      <button type="button" disabled={busy} onClick={() => setEditing('create')}>{t('list.newFolder')}</button>
      <label>{t('list.filter')} <input value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
      <label>{t('list.sort')} <select value={sort} onChange={(event) => setSort(event.target.value)}><option value="name">{t('list.nameAsc')}</option><option value="nameDesc">{t('list.nameDesc')}</option><option value="sizeAsc">{t('list.sizeAsc')}</option><option value="sizeDesc">{t('list.sizeDesc')}</option><option value="dateAsc">{t('list.dateAsc')}</option><option value="dateDesc">{t('list.dateDesc')}</option></select></label>
    </div>
    <PathBreadcrumb path={path} rootLabel="Storage" navigationLabel={t('list.path')} onNavigate={navigate} />
    <div aria-live="polite">{t('list.count', { count: visible.length, selected: selected.length })} {nextCursor && t('list.moreAvailable')}</div>
    {mobile ? <>{chosen.length > 0 && <button type="button" onClick={() => setActionsOpen(true)}>{t('list.actions', { count: chosen.length })}</button>}<BottomSheet open={actionsOpen && chosen.length > 0 && !moving && !editing} title={t('list.count', { count: visible.length, selected: selected.length })} onClose={() => setActionsOpen(false)}><div><button disabled={busy || chosen.length !== 1} onClick={() => setEditing(chosen[0])}>{t('list.rename')}</button> <button disabled={busy} onClick={() => setMoving(true)}>{t('list.move')}</button> <button disabled={busy} onClick={() => void remove()}>{t('list.delete')}</button> <button onClick={() => setSelected([])}>{t('list.clearSelection')}</button></div></BottomSheet></> : chosen.length > 0 && <div><button disabled={busy || chosen.length !== 1} onClick={() => setEditing(chosen[0])}>{t('list.rename')}</button> <button disabled={busy} onClick={() => setMoving(true)}>{t('list.move')}</button> <button disabled={busy} onClick={() => void remove()}>{t('list.delete')}</button> <button onClick={() => setSelected([])}>{t('list.clearSelection')}</button></div>}
    {moving && <StorageMovePicker backend={backend} initialPath={path} disabled={busy} onCancel={() => setMoving(false)} onMove={(destination) => { if (chosen.some((item) => item.type === 'directory' && destination.startsWith(item.path))) { showToast(t('list.invalidDestination')); return; } setMoving(false); void run(() => backend.moveMany(chosen, destination)); }} />}
    {dragOver && <div role="status" style={{ position: 'absolute', inset: 0, background: 'var(--accent-a15)', border: '2px dashed var(--accent)', pointerEvents: 'none', zIndex: 1 }}>{filesT('storage.dropToUpload')}</div>}
    {progress && <div role="status">{progress}</div>}
    {previews.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', maxHeight: 'min(25vh, calc(var(--space-6) * 6))', overflowY: 'auto', flexShrink: 0 }}>{previews.map((image) => <img key={image.url} src={image.url} alt={image.name} style={{ width: 64, height: 64, objectFit: 'contain', borderRadius: 'var(--radius-sm)' }} />)}</div>}
    {failures.length > 0 && <div role="alert" style={{ maxHeight: 'min(25vh, calc(var(--space-6) * 6))', overflowY: 'auto', overflowWrap: 'anywhere', flexShrink: 0 }}><div>{t('list.uploadFailures')}</div><ul>{failures.map((failure, index) => <li key={index}>{failure.path}: {failure.error}</li>)}</ul></div>}
    <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {editing === 'create' && <InlineNameInput initialValue="" kind="directory" siblingNames={entries.map((entry) => entry.name)} depth={0} onCancel={() => setEditing(null)} onCommit={(name) => { setEditing(null); void run(async () => { await backend.create(`${path}${name}/`, 'directory'); }); }} />}
      {loading && <LoadingState />}
      {error && <div role="alert">{error} <button onClick={() => void (nextCursor !== null ? loadMore() : refresh())}>{t('retry')}</button></div>}
      {!loading && !error && !visible.length && <EmptyState title={t('list.empty')} />}
      <FileTree nodes={visible} renderRow={(entry) => editing !== 'create' && editing?.path === entry.path ? <InlineNameInput key={entry.path} initialValue={entry.name} kind={entry.type} siblingNames={entries.filter((item) => item.path !== entry.path).map((item) => item.name)} depth={0} onCancel={() => setEditing(null)} onCommit={(name) => { setEditing(null); void run(() => backend.rename(entry.path, name)); }} /> : <div key={entry.path} className={`row-hover${selected.includes(entry.path) || activeTabId === `storage-file:${projectId}:${entry.path}` ? ' row-selected' : ''}`} style={{ display: 'flex', alignItems: 'center', minHeight: 44, gap: 'var(--space-2)', minWidth: 0 }} onTouchStart={() => { didLongPress.current = false; press.current = setTimeout(() => { didLongPress.current = true; select(entry, true, false); }, 500); }} onTouchEnd={() => { if (press.current) clearTimeout(press.current); }} onTouchMove={() => { if (press.current) clearTimeout(press.current); }}>
        <input type="checkbox" aria-label={t('list.select', { name: entry.name })} checked={selected.includes(entry.path)} onChange={() => select(entry, true, false)} />
        {entry.type === 'directory' ? <Icon name="files" size={16} /> : /\.(jpe?g|png|gif|webp|svg|bmp|ico)$/i.test(entry.name) ? <StorageThumbnail path={raw(entry)} /> : <Icon name="file" size={16} />}
        <button type="button" style={{ flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' }} onClick={(event) => { if (didLongPress.current) { didLongPress.current = false; return; } if (event.shiftKey || event.ctrlKey || event.metaKey) select(entry, true, event.shiftKey); else if (entry.type === 'directory') navigate(entry.path); else preview(entry); }}>{entry.name}</button>
        {entry.type === 'file' && <><button type="button" aria-label={filesT('storage.download')} title={filesT('storage.download')} onClick={() => void download(entry)}><Icon name="download" size={16} /></button><button type="button" aria-label={filesT('storage.copyUrl')} title={filesT('storage.copyUrl')} onClick={() => void copyUrl(entry)}><Icon name="external-link" size={16} /></button></>}
      </div>} />
      {nextCursor && <div ref={sentinel}><button disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? t('list.loading') : t('list.loadMore')}</button></div>}
    </div>
  </div>;
}

export async function uploadAndGetUrl(projectId: number, file: File): Promise<string | null> {
  try { const res = await uploadFile<{ file?: StoredFile; error?: string }>(`/projects/${projectId}/storage/upload`, file); if (res.error || !res.file) return null; const filename = res.file.key.split('/').pop() || ''; return `${window.location.origin}/api/projects/${projectId}/storage/${encodeURIComponent(filename)}/raw`; } catch { return null; }
}
