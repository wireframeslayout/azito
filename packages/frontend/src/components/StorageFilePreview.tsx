import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../hooks/useToast';
import { Icon } from './ui/Icon';
import { useBlobUrl } from '../hooks/useBlobUrl';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  pdf: 'application/pdf',
};

function mimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  return MIME_MAP[ext || ''] || 'application/octet-stream';
}

function isPdf(name: string): boolean {
  return /\.pdf$/i.test(name);
}

function isImage(name: string): boolean {
  return /\.(jpe?g|png|gif|webp|svg|bmp|ico)$/i.test(name);
}

interface StorageFilePreviewProps {
  projectId: number;
  filename: string;
  originalName: string;
  size: number;
}

export default function StorageFilePreview({ projectId, filename, originalName, size }: StorageFilePreviewProps) {
  const { t } = useTranslation('files');
  const { showToast } = useToast();
  const apiPath = `/projects/${projectId}/storage/${encodeURIComponent(filename)}/raw`;
  const fileUrl = `/api${apiPath}`;
  const fullUrl = `${window.location.origin}${fileUrl}`;
  const mimeType = mimeFromName(originalName);
  const fileIsPdf = isPdf(originalName);
  const fileIsImage = isImage(originalName);

  const { url: objectUrl, state: loadState } = useBlobUrl(apiPath, mimeType);

  const handleDownload = useCallback(() => {
    if (!objectUrl) return;
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = originalName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [objectUrl, originalName]);

  const handleCopyUrl = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(fullUrl);
      } else {
        const ta = document.createElement('textarea');
        ta.value = fullUrl;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      showToast(t('preview.copiedUrl'));
    } catch {
      showToast('Failed to copy URL');
    }
  }, [fullUrl, showToast]);

  const actionButtonStyle: React.CSSProperties = {
    background: 'none', border: '1px solid var(--border)', color: 'var(--text-dim)',
    cursor: 'pointer', fontSize: 'var(--font-xs)', padding: '3px 8px', borderRadius: 'var(--radius-sm)',
    display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, whiteSpace: 'nowrap',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--ws-surface)' }}>
      {/* Header bar */}
      <div style={{
        padding: '8px 16px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-card)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexShrink: 0,
        minHeight: 40,
      }}>
        <span style={{ display: 'inline-flex', alignItems: 'center' }}><Icon name={fileIsPdf ? 'file' : 'image'} size={14} /></span>
        <span style={{ fontSize: 'var(--font-md)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {originalName}
        </span>
        <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', flexShrink: 0 }}>
          {formatSize(size)} &middot; {mimeType}
        </span>
        <button
          onClick={handleDownload}
          disabled={loadState !== 'success'}
          title={t('preview.downloadFile')}
          style={{
            ...actionButtonStyle,
            opacity: loadState === 'success' ? 1 : 0.5,
            cursor: loadState === 'success' ? 'pointer' : 'not-allowed',
          }}
        >
          <Icon name="download" size={14} /> <span style={{ fontSize: 'var(--font-xs)' }}>{t('preview.downloadFile')}</span>
        </button>
        <button onClick={handleCopyUrl} title={t('preview.copyUrl')} style={actionButtonStyle}>
          <Icon name="external-link" size={14} /> <span style={{ fontSize: 'var(--font-xs)' }}>{t('preview.copyUrl')}</span>
        </button>
      </div>

      {/* Content */}
      {loadState === 'loading' && (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-dim)', fontSize: 'var(--font-sm)',
        }}>
          {t('preview.loading')}
        </div>
      )}
      {loadState === 'error' && (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 8, color: 'var(--text-dim)', fontSize: 'var(--font-sm)',
        }}>
          <span>{t('preview.loadError')}</span>
        </div>
      )}
      {loadState === 'success' && objectUrl && fileIsImage && (
        <div style={{ flex: 1, overflow: 'auto', padding: 0 }}>
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            padding: 24, minHeight: '100%',
          }}>
            <div style={{
              background: 'repeating-conic-gradient(rgba(255,255,255,0.06) 0% 25%, transparent 0% 50%) 50% / 16px 16px',
              borderRadius: 'var(--radius-md)', padding: 8, maxWidth: '100%',
            }}>
              <img
                src={objectUrl}
                alt={originalName}
                style={{ maxWidth: '100%', maxHeight: 'calc(100vh - 200px)', display: 'block', borderRadius: 'var(--radius-sm)' }}
              />
            </div>
            <div style={{ marginTop: 12, fontSize: 'var(--font-sm)', color: 'var(--text-dim)', textAlign: 'center' }}>
              {originalName} — {formatSize(size)} — {mimeType}
            </div>
          </div>
        </div>
      )}
      {loadState === 'success' && objectUrl && fileIsPdf && (
        <iframe
          src={objectUrl}
          title={originalName}
          style={{ flex: 1, width: '100%', border: 'none' }}
        />
      )}
    </div>
  );
}
