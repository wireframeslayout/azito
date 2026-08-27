import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, fetchBlob, uploadFile } from '../api/client';
import { LoadingState, EmptyState } from './ui';
import { Icon } from './ui/Icon';
import { useToast } from '../hooks/useToast';
import { useBlobUrl } from '../hooks/useBlobUrl';

interface PreviewItem { url: string; name: string; }

export interface StoredFile {
  key: string;
  originalName: string;
  size: number;
  lastModified: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(name: string): boolean {
  return /\.(jpe?g|png|gif|webp|svg|bmp|ico)$/i.test(name);
}

function isPdf(name: string): boolean {
  return /\.pdf$/i.test(name);
}

function isPreviewable(name: string): boolean {
  return isImage(name) || isPdf(name);
}

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function StorageThumb({ apiPath, alt }: { apiPath: string; alt: string }): React.ReactElement {
  const { url, state } = useBlobUrl(apiPath);

  if (state !== 'success' || !url) {
    return (
      <span style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--font-lg)', flexShrink: 0, color: 'var(--text-dim)' }}>
        <Icon name="image" size={16} />
      </span>
    );
  }

  return (
    <img
      src={url}
      alt={alt}
      style={{ width: 28, height: 28, borderRadius: 'var(--radius-sm)', objectFit: 'cover', flexShrink: 0 }}
    />
  );
}

export default function StoragePanel({ projectId, onFilePreview, activeTabId }: {
  projectId: number;
  onFilePreview?: (file: StoredFile) => void;
  activeTabId?: string | null;
}) {
  const { t } = useTranslation('files');
  const { showToast } = useToast();
  const mobile = typeof window !== 'undefined' && window.innerWidth <= 768;
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [previews, setPreviews] = useState<PreviewItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewsRef = useRef(previews);
  previewsRef.current = previews;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ files: StoredFile[] }>(`/projects/${projectId}/storage`);
      setFiles(res.files || []);
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  const addPreviews = useCallback((selected: File[]) => {
    const imgs = selected
      .filter((f) => f.type.startsWith('image/'))
      .map((f) => ({ url: URL.createObjectURL(f), name: f.name }));
    if (imgs.length > 0) setPreviews((prev) => [...prev, ...imgs]);
  }, []);

  const removePreview = useCallback((name: string) => {
    const current = previewsRef.current;
    const match = current.find((p) => p.name === name);
    if (!match) return;
    setPreviews((prev) => prev.filter((p) => p.url !== match.url));
    URL.revokeObjectURL(match.url);
  }, []);

  useEffect(() => {
    return () => { previewsRef.current.forEach((p) => URL.revokeObjectURL(p.url)); };
  }, []);

  const doUpload = useCallback(async (file: File) => {
    setUploading(true);
    try {
      const res = await uploadFile<{ ok: boolean; file?: StoredFile; error?: string }>(
        `/projects/${projectId}/storage/upload`, file,
      );
      if (res.error) {
        showToast(`Upload failed: ${res.error}`);
      } else if (res.file) {
        showToast(`Uploaded ${file.name}`);
        setFiles((prev) => prev.some((f) => f.key === res.file!.key) ? prev : [...prev, res.file!]);
      }
    } catch (err: unknown) {
      showToast(`Upload error: ${(err as Error).message}`);
    } finally {
      setUploading(false);
      removePreview(file.name);
    }
  }, [projectId, showToast, removePreview]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (mobile) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const droppedFiles = Array.from(e.dataTransfer.files);
    addPreviews(droppedFiles);
    for (const f of droppedFiles) doUpload(f);
  }, [doUpload, addPreviews, mobile]);

  const handleDelete = useCallback(async (filename: string) => {
    await api(`/projects/${projectId}/storage/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    setFiles((prev) => prev.filter((f) => (f.key.split('/').pop() || '') !== filename));
  }, [projectId]);

  const getApiPath = useCallback((file: StoredFile): string => {
    const filename = file.key.split('/').pop() || '';
    return `/projects/${projectId}/storage/${encodeURIComponent(filename)}/raw`;
  }, [projectId]);

  const getProxyUrl = useCallback((file: StoredFile): string => `/api${getApiPath(file)}`, [getApiPath]);

  const handleDownloadFile = useCallback(async (file: StoredFile) => {
    try {
      const blob = await fetchBlob(getApiPath(file));
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = file.originalName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
    } catch {
      showToast('Failed to download file');
    }
  }, [getApiPath, showToast]);

  const handleCopyUrl = useCallback(async (file: StoredFile) => {
    const url = `${window.location.origin}${getProxyUrl(file)}`;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      showToast(t('storage.copiedUrl'));
    } catch {
      showToast('Failed to copy URL');
    }
  }, [getProxyUrl, showToast]);

  return (
    <div
      style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      onDragEnter={(e) => { if (mobile) return; e.preventDefault(); e.stopPropagation(); setDragOver(true); }}
      onDragOver={(e) => { if (mobile) return; e.preventDefault(); e.stopPropagation(); }}
      onDragLeave={(e) => { if (mobile) return; e.stopPropagation(); setDragOver(false); }}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div style={{
        fontSize: 'var(--font-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5,
        color: 'var(--text-dim)', padding: '12px 12px 4px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span>
          Storage{' '}
          <span style={{ fontWeight: 400, fontSize: 'var(--font-2xs)', background: 'var(--bg)', padding: '1px 6px', borderRadius: 'var(--radius-md)' }}>
            {files.length}
          </span>
        </span>
        <button
          onClick={() => fileInputRef.current?.click()}
          title={t('storage.uploadFile')}
          className="icon-btn"
          style={{ border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: '2px 6px', display: 'inline-flex', alignItems: 'center' }}
        ><Icon name="plus" size={16} /></button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const selected = Array.from(e.target.files || []);
          addPreviews(selected);
          for (const f of selected) doUpload(f);
          e.target.value = '';
        }}
      />

      {/* Drop overlay */}
      {dragOver && !mobile && (
        <div style={{
          position: 'absolute', inset: 0, background: 'var(--accent-a15)',
          border: '2px dashed var(--accent)', borderRadius: 'var(--radius-md)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--accent)', fontSize: 'var(--font-base)', fontWeight: 600, zIndex: 10,
          pointerEvents: 'none',
        }}>
          {t('storage.dropToUpload')}
        </div>
      )}

      {/* Upload progress */}
      {uploading && (
        <div style={{ padding: '6px 12px', fontSize: 'var(--font-sm)', color: 'var(--accent)', background: 'var(--accent-a08)' }}>
          Uploading...
        </div>
      )}

      {/* Upload previews */}
      {previews.length > 0 && (
        <div style={{
          display: 'flex', gap: 8, padding: '8px 12px', flexWrap: 'wrap',
          borderBottom: '1px solid var(--border)', maxHeight: 140, overflowY: 'auto',
        }}>
          {previews.map((p) => (
            <div key={p.url} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: 80 }}>
              <img
                src={p.url} alt={p.name}
                style={{ width: 64, height: 64, borderRadius: 'var(--radius-sm)', objectFit: 'contain', background: 'rgba(255,255,255,0.04)' }}
              />
              <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 80, textAlign: 'center' }}>
                {p.name}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* File list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 8, position: 'relative' }}>
        {loading && files.length === 0 && <LoadingState />}
        {!loading && files.length === 0 && (
          <EmptyState title={t('storage.emptyMessage')} />
        )}
        {files.map((f) => {
          const filename = f.key.split('/').pop() || '';
          const isImg = isImage(f.originalName);
          const canPreview = isPreviewable(f.originalName) && onFilePreview;
          const tabId = `storage-file:${projectId}:${filename}`;
          const isActive = activeTabId === tabId;
          return (
            <div key={f.key}
              onClick={() => { if (canPreview) onFilePreview(f); }}
              role={canPreview ? 'button' : undefined}
              tabIndex={canPreview ? 0 : undefined}
              onKeyDown={(e) => { if (canPreview && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onFilePreview(f); } }}
              className={`row-hover${isActive ? ' row-selected' : ''}`}
              style={{
              padding: '8px 12px', fontSize: 'var(--font-md)', borderRadius: 'var(--radius-sm)', margin: '1px 0',
              display: 'flex', alignItems: 'center', gap: 8, minHeight: 40,
              cursor: canPreview ? 'pointer' : 'default',
              color: isActive ? 'var(--accent)' : 'inherit',
            }}>
              {/* Thumbnail or icon */}
              {isImg ? (
                <StorageThumb apiPath={getApiPath(f)} alt={f.originalName} />
              ) : (
                <span style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--font-lg)', flexShrink: 0, color: 'var(--text-dim)' }}>
                  <Icon name="file" size={16} />
                </span>
              )}

              {/* File info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--font-md)' }}>
                  {f.originalName}
                </div>
                <div style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)' }}>
                  {formatSize(f.size)} &middot; {timeAgo(f.lastModified)}
                </div>
              </div>

              {/* Actions */}
              <button
                onClick={(e) => { e.stopPropagation(); handleDownloadFile(f); }}
                title={t('storage.download')}
                className="icon-btn"
                style={{ border: 'none', cursor: 'pointer', color: 'var(--text-dim)', padding: '2px 4px', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}
              ><Icon name="download" size={14} /></button>
              <button
                onClick={(e) => { e.stopPropagation(); handleCopyUrl(f); }}
                title={t('storage.copyUrl')}
                className="icon-btn"
                style={{ border: 'none', cursor: 'pointer', color: 'var(--text-dim)', padding: '2px 4px', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}
              ><Icon name="external-link" size={14} /></button>
              <button
                onClick={(e) => { e.stopPropagation(); handleDelete(filename); }}
                title={t('storage.deleteFile')}
                className="icon-btn"
                style={{ border: 'none', cursor: 'pointer', color: 'var(--danger)', padding: '2px 4px', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}
              ><Icon name="trash" size={14} /></button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export async function uploadAndGetUrl(projectId: number, file: File): Promise<string | null> {
  try {
    const res = await uploadFile<{ ok: boolean; file?: StoredFile; error?: string }>(
      `/projects/${projectId}/storage/upload`, file,
    );
    if (res.error || !res.file) return null;
    const filename = res.file.key.split('/').pop() || '';
    return `${window.location.origin}/api/projects/${projectId}/storage/${encodeURIComponent(filename)}/raw`;
  } catch {
    return null;
  }
}
