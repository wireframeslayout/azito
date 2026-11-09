import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { useToast } from '../../hooks/useToast';
import { useServerPath } from '../../hooks/useServerPath';
import { fileDisplayName } from '../../lib/serverPath';
import { Icon } from '../ui/Icon';
import { ServerFilesBackend } from './backend/ServerFilesBackend';
import { TextFileEditor } from './TextFileEditor';
import { useFileDownload } from './useFileDownload';
import { Button } from '../ui';
import { filePreviewKind } from '../preview/filePreviewKind';
import { PreviewSwitch } from '../preview/PreviewSwitch';

interface FilePreviewPanelProps {
  serverName: string;
  filePath: string;
  projectId?: number;
  initialLine?: number;
  onDirtyChange?: (dirty: boolean) => void;
}
interface MediaContent { type: 'image' | 'pdf'; mimeType: string; base64: string; size: number; error?: string }

function MediaPreview({ serverName, filePath, backend, openInEditor }: FilePreviewPanelProps & { backend: ServerFilesBackend; openInEditor: (target: 'vscode' | 'zed') => Promise<void> }) {
  const { t } = useTranslation('files');
  const pathApi = useServerPath(serverName);
  const [media, setMedia] = useState<MediaContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setMedia(null); setError(null);
    api<MediaContent>(`/servers/${encodeURIComponent(serverName)}/files/content?path=${encodeURIComponent(filePath)}`)
      .then((result) => { if (active) result.error ? setError(result.error) : setMedia(result); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : String(err)); });
    return () => { active = false; };
  }, [serverName, filePath]);
  const fileName = pathApi ? fileDisplayName(pathApi, filePath) : filePath;
  const download = useFileDownload(backend, filePath, fileName);
  const buttonStyle: React.CSSProperties = { background: 'none', border: '1px solid var(--border)', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 'var(--font-xs)', padding: 'var(--space-1) var(--space-2)', borderRadius: 'var(--radius-sm)', whiteSpace: 'nowrap', flexShrink: 0 };
  return <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--ws-surface)' }}>
    <div style={{ padding: 'var(--space-2) var(--space-4)', borderBottom: '1px solid var(--border)', background: 'var(--bg-card)', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-3)', flexShrink: 0 }}>
      <Icon name={media?.type === 'image' ? 'image' : 'file'} size={14} />
      <span style={{ fontSize: 'var(--font-md)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{filePath}</span>
      {media && <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>{media.size < 1024 ? `${media.size} B` : `${Math.round(media.size / 1024)} KB`} · {media.type === 'pdf' ? 'PDF' : media.mimeType}</span>}
      <button onClick={() => void download()} title={t('explorer.download')} style={buttonStyle}><Icon name="download" size={14} /> {t('explorer.download')}</button>
      <button onClick={() => void openInEditor('vscode')} title={t('explorer.openInVsCode')} className="btn-ghost" style={buttonStyle}>VS Code</button>
      <button onClick={() => void openInEditor('zed')} title={t('explorer.openInZed')} className="btn-ghost" style={buttonStyle}>Zed</button>
    </div>
    <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
      {error ? <div role="alert" style={{ padding: 'var(--space-4)', color: 'var(--danger)' }}>{error}</div> : !media ? <div style={{ padding: 'var(--space-4)', color: 'var(--text-dim)' }}>{t('preview.loading')}</div> : media.type === 'image' ?
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-4)', minHeight: '100%' }}>
          <div style={{ background: 'repeating-conic-gradient(rgba(255,255,255,0.06) 0% 25%, transparent 0% 50%) 50% / 16px 16px', borderRadius: 'var(--radius-md)', padding: 'var(--space-2)', maxWidth: '100%' }}><img src={`data:${media.mimeType};base64,${media.base64}`} alt={fileName} style={{ maxWidth: '100%', maxHeight: 'calc(100vh - 200px)', display: 'block', borderRadius: 'var(--radius-sm)' }} /></div>
          <div style={{ marginTop: 'var(--space-3)', fontSize: 'var(--font-sm)', color: 'var(--text-dim)', textAlign: 'center' }}>{fileName} — {media.size < 1024 ? `${media.size} B` : `${Math.round(media.size / 1024)} KB`} — {media.mimeType}</div>
        </div> : <iframe src={`data:application/pdf;base64,${media.base64}`} title={fileName} style={{ width: '100%', height: '100%', border: 'none' }} />}
    </div>
  </div>;
}

export function FilePreviewPanel(props: FilePreviewPanelProps) {
  const backend = useMemo(() => new ServerFilesBackend(props.serverName, props.projectId), [props.serverName, props.projectId]);
  const { t } = useTranslation('files');
  const { showToast } = useToast();
  const download = useFileDownload(backend, props.filePath, props.filePath.split(/[\\/]/).pop() || props.filePath);
  const openInEditor = async (target: 'vscode' | 'zed') => {
    try {
      const result = await api<{ uri?: string }>(`/servers/${encodeURIComponent(props.serverName)}/editor-uri?path=${encodeURIComponent(props.filePath)}&editor=${target}`);
      if (result.uri) window.location.href = result.uri;
    } catch { showToast(t('preview.loadError')); }
  };
  if (/\.(png|jpe?g|gif|svg|webp|ico|bmp|pdf)$/i.test(props.filePath)) return <MediaPreview {...props} backend={backend} openInEditor={openInEditor} />;
  if (filePreviewKind(props.filePath) !== 'other') return <PreviewSwitch backend={backend} path={props.filePath} name={props.filePath.split(/[\\/]/).pop() || props.filePath} download={() => void download()} onDirtyChange={props.onDirtyChange} />;
  const downloadAction = <Button size="sm" variant="ghost" onClick={() => void download()} title={t('explorer.download')}><Icon name="download" size={14} /> {t('explorer.download')}</Button>;
  return <TextFileEditor backend={backend} path={props.filePath} name={props.filePath} initialLine={props.initialLine} downloadAction={downloadAction} headerActions={<>{downloadAction}<Button size="sm" variant="ghost" title={t('explorer.openInVsCode')} onClick={() => void openInEditor('vscode')}>VS Code</Button><Button size="sm" variant="ghost" title={t('explorer.openInZed')} onClick={() => void openInEditor('zed')}>Zed</Button></>} onDirtyChange={props.onDirtyChange} />;
}
