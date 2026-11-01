import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchBlob, uploadFile } from '../api/client';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { formatSize } from '../utils/formatSize';
import { BottomSheet } from './ui/BottomSheet';
import { Button, EmptyState, FormInput, FormSelect, LoadingState } from './ui';
import InlineNameInput from './files/InlineNameInput';
import { PathBreadcrumb } from './files/PathBreadcrumb';
import FileTree from './files/FileTree';
import type { FileEntry } from './files/backend/FilesBackend';
import { StorageApiError, StorageFilesBackend } from './files/backend/StorageFilesBackend';
import { StorageStatusGate } from './storage/StorageStatusGate';
import { useStorageEntries } from './storage/useStorageEntries';
import { StorageMovePicker } from './storage/StorageMovePicker';
import { StorageEntryRow } from './storage/StorageEntryRow';
import { StorageSelectionActions } from './storage/StorageSelectionActions';
import { collectStorageDrop, uploadStorageDrop, type StorageDropItem, type StorageDropFailure } from './storage/storageDrop';

export interface StoredFile { key: string; originalName: string; size: number; lastModified: string }
interface StoragePanelProps { projectId: number; onFilePreview?: (file: StoredFile) => void; activeTabId?: string | null }
export default function StoragePanel(props: StoragePanelProps) {
  return <StorageStatusGate projectId={props.projectId}><StorageFileList key={props.projectId} {...props} /></StorageStatusGate>;
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
  type Sort = 'name' | 'nameDesc' | 'sizeAsc' | 'sizeDesc' | 'dateAsc' | 'dateDesc';
  const [sort, setSort] = useState<Sort>('name');
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
  const actionsButton = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const movingWasOpen = useRef(false);
  useEffect(() => {
    if (mobile && movingWasOpen.current && !moving) (actionsButton.current?.querySelector('button') ?? toolbar.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
    movingWasOpen.current = moving;
  }, [mobile, moving]);
  const touchStyle = mobile ? { minHeight: 'calc(var(--space-6) + var(--space-5))', minWidth: 'calc(var(--space-6) + var(--space-5))' } : undefined;
  const operationMessage = (error: unknown) => {
    if (error instanceof StorageApiError && error.code && ['exists', 'folder_too_large', 'partial_failure', 'invalid_path'].includes(error.code)) return t(`list.errors.${error.code}`);
    return error instanceof Error ? error.message : t('list.operationError');
  };
  const sentinel = useRef<HTMLDivElement>(null);
  const visible = entries.filter((entry) => entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    if (sort === 'dateAsc' || sort === 'dateDesc') return (a.lastModified === undefined && b.lastModified === undefined ? 0 : a.lastModified === undefined ? 1 : b.lastModified === undefined ? -1 : (sort === 'dateAsc' ? 1 : -1) * a.lastModified.localeCompare(b.lastModified)) || a.name.localeCompare(b.name);
    if (sort === 'sizeAsc' || sort === 'sizeDesc') return (a.size === undefined && b.size === undefined ? 0 : a.size === undefined ? 1 : b.size === undefined ? -1 : (sort === 'sizeAsc' ? 1 : -1) * (a.size - b.size)) || a.name.localeCompare(b.name);
    return (sort === 'nameDesc' ? -1 : 1) * a.name.localeCompare(b.name);
  });
  const chosen = visible.filter((entry) => selected.includes(entry.path));
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
    catch (err) { showToast(operationMessage(err)); await refresh(); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!chosen.length || busy) return;
    setBusy(true);
    try {
      const stats = await Promise.all(chosen.filter((entry) => entry.type === 'directory').map((entry) => backend.stat(entry.path)));
      const count = stats.reduce((sum, item) => sum + item.count, 0);
      const size = stats.reduce((sum, item) => sum + item.totalSize, 0);
      const names = chosen.map((entry) => entry.name).join(', ');
      const message = stats.length ? t('list.deleteMessage', { names, count, size: formatSize(size) }) : t('list.deleteMessageFiles', { names });
      if (await confirm({ title: t('list.deleteTitle'), message, danger: true })) {
        await backend.deleteMany(chosen); setSelected([]); await refresh();
      }
    } catch (err) { showToast(operationMessage(err)); await refresh(); }
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
    if (mobile || !isFileDrag(event)) return;
    event.preventDefault(); event.stopPropagation(); setDragOver(false);
    if (busy) showToast(t('list.busy'));
    else void uploadItems(collectStorageDrop(event.dataTransfer));
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
  const selectionActions = <StorageSelectionActions count={chosen.length} busy={busy} mobile={mobile} onRename={() => setEditing(chosen[0])} onMove={() => { if (mobile) { setActionsOpen(false); actionsButton.current?.querySelector('button')?.focus(); } setMoving(true); }} onDelete={() => void remove()} onClear={() => setSelected([])} />;
  function preview(entry: FileEntry) { onFilePreview?.({ key: `projects/${projectId}/${entry.path}`, originalName: entry.name, size: entry.size ?? 0, lastModified: entry.lastModified ?? '' }); }
  return <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative', minWidth: 0 }}
    onDragEnter={(event) => { if (mobile || !isFileDrag(event)) return; event.preventDefault(); event.stopPropagation(); setDragOver(true); }}
    onDragOver={(event) => { if (mobile || !isFileDrag(event)) return; event.preventDefault(); event.stopPropagation(); }}
    onDragLeave={(event) => { if (mobile || !isFileDrag(event)) return; event.stopPropagation(); if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false); }} onDrop={(event) => void drop(event)}>
    <div ref={toolbar} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-2)' }}>
      <Button style={touchStyle} size="sm" variant="primary" type="button" disabled={busy} onClick={() => input.current?.click()}>{filesT('storage.uploadFile')}</Button>
      <input ref={input} type="file" multiple hidden onChange={(event) => { void uploadItems(Promise.resolve(Array.from(event.target.files ?? []).map((file) => ({ type: 'file' as const, path: file.name, file })))); event.target.value = ''; }} />
      <Button style={touchStyle} size="sm" type="button" disabled={busy} onClick={() => setEditing('create')}>{t('list.newFolder')}</Button>
      <FormInput aria-label={t('list.filter')} placeholder={t('list.filter')} value={filter} onChange={(event) => setFilter(event.target.value)} style={{ flex: '1 1 8rem', width: 'auto', minWidth: 0, padding: 'var(--space-1) var(--space-2)', fontSize: 'var(--font-sm)' }} />
      <FormSelect aria-label={t('list.sort')} value={sort} onChange={(event) => setSort(event.target.value as Sort)} style={{ width: 'auto', padding: 'var(--space-1) var(--space-2)', fontSize: 'var(--font-sm)' }}><option value="name">{t('list.nameAsc')}</option><option value="nameDesc">{t('list.nameDesc')}</option><option value="sizeAsc">{t('list.sizeAsc')}</option><option value="sizeDesc">{t('list.sizeDesc')}</option><option value="dateAsc">{t('list.dateAsc')}</option><option value="dateDesc">{t('list.dateDesc')}</option></FormSelect>
    </div>
    <PathBreadcrumb mobile={mobile} path={path} rootLabel={t('list.root')} navigationLabel={t('list.path')} onNavigate={navigate} />
    <div aria-live="polite" style={{ padding: '0 var(--space-2)', fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>{t('list.count', { count: visible.length, selected: chosen.length })} {nextCursor && t('list.moreAvailable')}</div>
    {chosen.length > 0 && (mobile
      ? <div ref={actionsButton} style={{ padding: 'var(--space-2)' }}><Button style={touchStyle} size="sm" type="button" onClick={() => setActionsOpen(true)}>{t('list.actions', { count: chosen.length })}</Button></div>
      : <div style={{ padding: 'var(--space-2)' }}>{selectionActions}</div>)}
    {mobile && <BottomSheet open={actionsOpen && chosen.length > 0 && !moving && !editing} title={t('list.count', { count: visible.length, selected: chosen.length })} onClose={() => setActionsOpen(false)}>{selectionActions}</BottomSheet>}
    {moving && <StorageMovePicker backend={backend} initialPath={path} disabled={busy} mobile={mobile} fallbackFocusTo={actionsButton.current?.querySelector('button')} onCancel={() => setMoving(false)} onMove={(destination) => { if (chosen.some((item) => item.type === 'directory' && destination.startsWith(item.path))) { showToast(t('list.invalidDestination')); return; } setMoving(false); void run(() => backend.moveMany(chosen, destination)); }} />}
    {dragOver && <div role="status" style={{ position: 'absolute', inset: 0, background: 'var(--accent-a15)', border: '2px dashed var(--accent)', pointerEvents: 'none', zIndex: 1 }}>{filesT('storage.dropToUpload')}</div>}
    {progress && <div role="status" style={{ padding: 'var(--space-2)', color: 'var(--text-dim)' }}>{progress}</div>}
    {previews.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', maxHeight: 'min(25vh, calc(var(--space-6) * 6))', overflowY: 'auto', flexShrink: 0 }}>{previews.map((image) => <img key={image.url} src={image.url} alt={image.name} style={{ width: 'calc(var(--space-6) * 2 + var(--space-4))', height: 'calc(var(--space-6) * 2 + var(--space-4))', objectFit: 'contain', borderRadius: 'var(--radius-sm)' }} />)}</div>}
    {failures.length > 0 && <div role="alert" style={{ maxHeight: 'min(25vh, calc(var(--space-6) * 6))', overflowY: 'auto', overflowWrap: 'anywhere', flexShrink: 0, padding: 'var(--space-2)', color: 'var(--danger)' }}><div>{t('list.uploadFailures')}</div><ul>{failures.map((failure, index) => <li key={index}>{failure.path}: {failure.error}</li>)}</ul></div>}
    <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {editing === 'create' && <InlineNameInput initialValue="" kind="directory" siblingNames={entries.map((entry) => entry.name)} depth={0} onCancel={() => setEditing(null)} onCommit={(name) => { setEditing(null); void run(async () => { await backend.create(`${path}${name}/`, 'directory'); }); }} />}
      {loading && <LoadingState />}
      {error && <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-2)', color: 'var(--danger)' }}>{error} <Button size="sm" type="button" onClick={() => void (nextCursor !== null ? loadMore() : refresh())}>{t('retry')}</Button></div>}
      {!loading && !error && !visible.length && <EmptyState title={t('list.empty')} />}
      <FileTree nodes={visible} renderRow={(entry, depth) => editing !== 'create' && editing?.path === entry.path
        ? <InlineNameInput initialValue={entry.name} kind={entry.type} siblingNames={entries.filter((item) => item.path !== entry.path).map((item) => item.name)} depth={depth} onCancel={() => setEditing(null)} onCommit={(name) => { setEditing(null); void run(() => backend.rename(entry.path, name)); }} />
        : <StorageEntryRow mobile={mobile} selectionMode={selected.length > 0} entry={entry} rawPath={raw(entry)} isSelected={selected.includes(entry.path)} isActive={activeTabId === `storage-file:${projectId}:${entry.path}`}
          onToggle={() => select(entry, true, false)} onRangeSelect={() => select(entry, true, true)}
          onOpen={() => { if (entry.type === 'directory') navigate(entry.path); else preview(entry); }}
          onDownload={() => void download(entry)} onCopyUrl={() => void copyUrl(entry)} />} />
      {nextCursor && <div ref={sentinel} style={{ padding: 'var(--space-2)' }}><Button size="sm" variant="ghost" type="button" loading={loadingMore} loadingLabel={t('list.loading')} onClick={() => void loadMore()}>{t('list.loadMore')}</Button></div>}
    </div>
  </div>;
}

export async function uploadAndGetUrl(projectId: number, file: File): Promise<string | null> {
  try { const res = await uploadFile<{ file?: StoredFile; error?: string }>(`/projects/${projectId}/storage/upload`, file); if (res.error || !res.file) return null; const filename = res.file.key.split('/').pop() || ''; return `${window.location.origin}/api/projects/${projectId}/storage/${encodeURIComponent(filename)}/raw`; } catch { return null; }
}
