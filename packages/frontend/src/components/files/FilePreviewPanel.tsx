import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, fetchBlob } from '../../api/client';
import { useToast } from '../../hooks/useToast';
import MarkdownRenderer, { mdStyles } from '../MarkdownRenderer';
import { Icon } from '../ui/Icon';
import { LoadingState } from '../ui';

/* ── Types ── */

interface FileContent {
  content: string;
  path: string;
  size: number;
  language: string;
  mtime: number;
}

interface ImageContent {
  type: 'image';
  mimeType: string;
  base64: string;
  path: string;
  size: number;
}

interface PdfContent {
  type: 'pdf';
  mimeType: string;
  base64: string;
  path: string;
  size: number;
}

type FileResponse = (FileContent & { type?: undefined; error?: string }) | (ImageContent & { error?: string }) | (PdfContent & { error?: string });

/* ── Internal components ── */

type MdViewMode = 'source' | 'preview' | 'split';
type SaveStatus = 'clean' | 'dirty' | 'saving' | 'saved' | 'conflict';

const LazyCodeEditorView = React.lazy(() => import('../editor/CodeEditorView'));
const LazyEditorStatusBar = React.lazy(() => import('../editor/EditorStatusBar'));

function EditorWithStatusBar({
  content,
  language,
  initialLine,
  vimMode,
  saveStatus,
  onContentChange,
  onSave,
  onVimToggle,
}: {
  content: string;
  language: string;
  initialLine?: number;
  vimMode: boolean;
  saveStatus: SaveStatus;
  onContentChange: (val: string) => void;
  onSave: () => void;
  onVimToggle: () => void;
}) {
  const [cursorPos, setCursorPos] = useState({ line: initialLine ?? 1, col: 1 });
  const [vimModeDisplay, setVimModeDisplay] = useState('');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <React.Suspense fallback={<LoadingState />}>
          <LazyCodeEditorView
            value={content}
            language={language}
            initialLine={initialLine}
            vimMode={vimMode}
            onChange={onContentChange}
            onSave={onSave}
            onCursorChange={(line, col) => setCursorPos({ line, col })}
            onVimModeDisplay={setVimModeDisplay}
          />
        </React.Suspense>
      </div>
      <React.Suspense fallback={null}>
        <LazyEditorStatusBar
          vimModeDisplay={vimModeDisplay}
          line={cursorPos.line}
          col={cursorPos.col}
          vimEnabled={vimMode}
          onVimToggle={onVimToggle}
          saveStatus={saveStatus}
        />
      </React.Suspense>
    </div>
  );
}

function MarkdownFileView({
  content,
  language,
  mode,
  initialLine,
  vimMode,
  saveStatus,
  onContentChange,
  onSave,
  onVimToggle,
}: {
  content: string;
  language: string;
  mode: MdViewMode;
  initialLine?: number;
  vimMode: boolean;
  saveStatus: SaveStatus;
  onContentChange: (val: string) => void;
  onSave: () => void;
  onVimToggle: () => void;
}) {
  if (mode === 'source') {
    return (
      <EditorWithStatusBar
        content={content}
        language={language}
        initialLine={initialLine}
        vimMode={vimMode}
        saveStatus={saveStatus}
        onContentChange={onContentChange}
        onSave={onSave}
        onVimToggle={onVimToggle}
      />
    );
  }
  if (mode === 'preview') {
    return (
      <div style={{ padding: '24px 32px', maxWidth: 900, margin: '0 auto' }}>
        <style>{mdStyles}</style>
        <MarkdownRenderer content={content} />
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ flex: 1, overflow: 'hidden', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
        <EditorWithStatusBar
          content={content}
          language={language}
          initialLine={initialLine}
          vimMode={vimMode}
          saveStatus={saveStatus}
          onContentChange={onContentChange}
          onSave={onSave}
          onVimToggle={onVimToggle}
        />
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '24px 32px' }}>
        <style>{mdStyles}</style>
        <MarkdownRenderer content={content} />
      </div>
    </div>
  );
}

interface SaveResponse {
  ok?: boolean;
  mtime?: number;
  error?: string;
  currentMtime?: number;
}

/* ── File Preview Panel (for main area) ── */

export function FilePreviewPanel({
  serverName,
  filePath,
  projectId,
  initialLine,
  onDirtyChange,
}: {
  serverName: string;
  filePath: string;
  /** Required to save edits: the containment check on the server resolves the allowed root from the project's working directory. */
  projectId?: number;
  initialLine?: number;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation('files');
  const { showToast } = useToast();
  const [file, setFile] = useState<FileContent | null>(null);
  const [image, setImage] = useState<ImageContent | null>(null);
  const [pdf, setPdf] = useState<PdfContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mdViewMode, setMdViewMode] = useState<MdViewMode>(() => {
    const stored = localStorage.getItem('azito-md-view-mode');
    return stored === 'source' || stored === 'preview' || stored === 'split' ? stored : 'preview';
  });

  const [editedContent, setEditedContent] = useState<string | null>(null);
  const [baseMtime, setBaseMtime] = useState<number | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('clean');
  const [vimMode, setVimMode] = useState(() => {
    if (window.matchMedia('(max-width: 768px)').matches) return false;
    return localStorage.getItem('azito-editor-vim-mode') === 'true';
  });
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  useEffect(() => () => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
  }, []);

  const isMarkdown = file?.language === 'markdown';
  const isDirty = editedContent !== null;
  const currentContent = editedContent ?? file?.content ?? '';

  useEffect(() => {
    onDirtyChangeRef.current?.(isDirty);
  }, [isDirty]);

  const handleMdViewMode = (mode: MdViewMode) => {
    setMdViewMode(mode);
    localStorage.setItem('azito-md-view-mode', mode);
  };

  const handleVimToggle = useCallback(() => {
    setVimMode(prev => {
      const next = !prev;
      localStorage.setItem('azito-editor-vim-mode', String(next));
      return next;
    });
  }, []);

  const fetchFileRef = useRef(0);

  const fetchFile = useCallback(async () => {
    const seq = ++fetchFileRef.current;
    setLoading(true);
    setError(null);
    setFile(null);
    setImage(null);
    setPdf(null);
    setEditedContent(null);
    setSaveStatus('clean');
    try {
      const res = await api<FileResponse>(`/servers/${serverName}/files/content?path=${encodeURIComponent(filePath)}`);
      if (seq !== fetchFileRef.current) return;
      if (res.error) { setError(res.error); }
      else if (res.type === 'image') { setImage(res); }
      else if (res.type === 'pdf') { setPdf(res); }
      else {
        const fc = res as FileContent;
        setFile(fc);
        setBaseMtime(fc.mtime ?? null);
      }
    } catch {
      if (seq !== fetchFileRef.current) return;
      setError('Failed to load file');
    }
    if (seq === fetchFileRef.current) setLoading(false);
  }, [serverName, filePath]);

  useEffect(() => { fetchFile(); }, [fetchFile]);

  const handleContentChange = useCallback((val: string) => {
    setEditedContent(val);
    setSaveStatus('dirty');
  }, []);

  const handleSave = useCallback(async (force = false) => {
    if (!file || saveStatus === 'saving') return;
    if (projectId == null) {
      setError('Save failed: projectId is required');
      return;
    }
    const content = editedContent ?? file.content;
    setSaveStatus('saving');
    try {
      const res = await api<SaveResponse>(`/servers/${serverName}/files/content`, {
        method: 'PUT',
        body: JSON.stringify({
          path: filePath,
          content,
          projectId,
          baseMtime: force ? undefined : baseMtime,
          force,
        }),
      });
      if (res.error === 'conflict') {
        setSaveStatus('conflict');
        return;
      }
      if (res.ok && res.mtime != null) {
        setBaseMtime(res.mtime);
        setFile(prev => prev ? { ...prev, content, mtime: res.mtime! } : prev);
        setEditedContent(null);
        setSaveStatus('saved');
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setSaveStatus('clean'), 2000);
      } else if (res.error && res.error !== 'conflict') {
        setSaveStatus('dirty');
        setError(`Save failed: ${res.error}`);
      }
    } catch {
      setSaveStatus('dirty');
    }
  }, [file, editedContent, serverName, filePath, projectId, baseMtime, saveStatus]);

  const handleReload = useCallback(() => {
    fetchFile();
  }, [fetchFile]);

  const handleForceOverwrite = useCallback(() => {
    handleSave(true);
  }, [handleSave]);

  const openInEditor = async (editor: 'vscode' | 'zed') => {
    try {
      const res = await api<{ uri?: string }>(
        `/servers/${serverName}/editor-uri?path=${encodeURIComponent(filePath)}&editor=${editor}`
      );
      if (res.uri) {
        window.location.href = res.uri;
      }
    } catch {
      // silently ignore
    }
  };

  const editorButtonStyle: React.CSSProperties = {
    background: 'none',
    border: '1px solid var(--border)',
    color: 'var(--text-dim)',
    cursor: 'pointer',
    fontSize: 'var(--font-xs)',
    padding: '2px 8px',
    borderRadius: 'var(--radius-sm)',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  };

  const fileName = filePath.split('/').pop() || filePath;
  const activeSize = file?.size ?? image?.size ?? pdf?.size;

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
        <span style={{ display: 'inline-flex', alignItems: 'center' }}><Icon name={image ? 'image' : 'file'} size={14} /></span>
        <span style={{ fontSize: 'var(--font-md)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {filePath}
        </span>
        {activeSize != null && (
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', flexShrink: 0 }}>
            {activeSize < 1024 ? activeSize + ' B' : Math.round(activeSize / 1024) + ' KB'}
            {file ? ' · ' + file.language : image ? ' · ' + image.mimeType : pdf ? ' · PDF' : ''}
          </span>
        )}
        {file && (
          <button
            onClick={() => handleSave()}
            disabled={!isDirty || saveStatus === 'saving' || saveStatus === 'conflict'}
            title="Save (Ctrl+S)"
            style={{
              background: isDirty ? 'var(--accent)' : 'transparent',
              border: isDirty ? '1px solid var(--accent)' : '1px solid var(--border)',
              color: isDirty ? '#fff' : 'var(--text-dim)',
              cursor: isDirty ? 'pointer' : 'default',
              fontSize: 11,
              fontWeight: 600,
              padding: '3px 12px',
              borderRadius: 4,
              whiteSpace: 'nowrap',
              flexShrink: 0,
              opacity: isDirty ? 1 : 0.5,
              minHeight: 24,
            }}
          >
            {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? '✓ Saved' : 'Save'}
          </button>
        )}
        {isMarkdown && (
          <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }} role="group" aria-label="Markdown view mode">
            {(['source', 'preview', 'split'] as const).map((mode, i) => {
              const isActive = mdViewMode === mode;
              const label = mode === 'source' ? t('explorer.sourceView') : mode === 'preview' ? t('explorer.previewView') : t('explorer.splitView');
              return (
                <button
                  key={mode}
                  onClick={() => handleMdViewMode(mode)}
                  aria-pressed={isActive}
                  style={{
                    background: isActive ? 'var(--bg-hover)' : 'none',
                    border: '1px solid',
                    borderColor: isActive ? 'var(--accent)' : 'var(--border)',
                    color: isActive ? 'var(--accent)' : 'var(--text-dim)',
                    cursor: 'pointer',
                    fontSize: 'var(--font-xs)',
                    padding: '2px 8px',
                    borderRadius: i === 0 ? '4px 0 0 4px' : i === 2 ? '0 4px 4px 0' : 0,
                    marginLeft: i > 0 ? -1 : 0,
                    position: 'relative',
                    zIndex: isActive ? 1 : 0,
                    whiteSpace: 'nowrap',
                    minHeight: 24,
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
        <button
          onClick={async () => {
            try {
              const blob = await fetchBlob(
                `/servers/${encodeURIComponent(serverName)}/files/download?path=${encodeURIComponent(filePath)}`,
              );
              const objectUrl = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = objectUrl;
              a.download = fileName;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(objectUrl);
            } catch {
              showToast(t('explorer.downloadFailed'));
            }
          }}
          title={t('explorer.download')}
          style={{
            background: 'none', border: '1px solid var(--border)', color: 'var(--text-dim)',
            cursor: 'pointer', fontSize: 'var(--font-md)', padding: '3px 8px', borderRadius: 'var(--radius-sm)',
            display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
          }}
        >
          <Icon name="download" size={14} /> <span style={{ fontSize: 'var(--font-xs)' }}>{t('explorer.download')}</span>
        </button>
        <button onClick={() => openInEditor('vscode')} title={t('explorer.openInVsCode')} className="btn-ghost" style={editorButtonStyle}>
          VS Code
        </button>
        <button onClick={() => openInEditor('zed')} title={t('explorer.openInZed')} className="btn-ghost" style={editorButtonStyle}>
          Zed
        </button>
      </div>

      {/* Conflict banner */}
      {saveStatus === 'conflict' && (
        <div style={{
          padding: '8px 16px',
          background: 'var(--orange-a08)',
          borderBottom: '1px solid var(--orange)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          fontSize: 12,
          flexShrink: 0,
        }}>
          <span style={{ color: 'var(--orange)', fontWeight: 600, flex: 1 }}>
            This file has been modified on the server.
          </span>
          <button
            onClick={handleReload}
            style={{
              background: 'var(--accent)',
              border: '1px solid var(--accent)',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 600,
              padding: '3px 12px',
              borderRadius: 4,
            }}
          >
            Reload
          </button>
          <button
            onClick={handleForceOverwrite}
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--text-dim)',
              cursor: 'pointer',
              fontSize: 11,
              padding: '3px 12px',
              borderRadius: 4,
            }}
          >
            Overwrite
          </button>
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflow: file ? 'hidden' : 'auto', padding: 0, minHeight: 0 }}>
        {loading && (
          <div style={{ padding: 24, color: 'var(--text-dim)', fontSize: 'var(--font-md)' }}>Loading {fileName}...</div>
        )}
        {error && (
          <div style={{ padding: 24, color: 'var(--danger)', fontSize: 'var(--font-md)' }}>{error}</div>
        )}
        {file && isMarkdown ? (
          <MarkdownFileView
            content={currentContent}
            language={file.language}
            mode={mdViewMode}
            initialLine={initialLine}
            vimMode={vimMode}
            saveStatus={saveStatus}
            onContentChange={handleContentChange}
            onSave={() => handleSave()}
            onVimToggle={handleVimToggle}
          />
        ) : file ? (
          <EditorWithStatusBar
            content={currentContent}
            language={file.language}
            initialLine={initialLine}
            vimMode={vimMode}
            saveStatus={saveStatus}
            onContentChange={handleContentChange}
            onSave={() => handleSave()}
            onVimToggle={handleVimToggle}
          />
        ) : null}
        {image && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            minHeight: '100%',
          }}>
            <div style={{
              background: 'repeating-conic-gradient(rgba(255,255,255,0.06) 0% 25%, transparent 0% 50%) 50% / 16px 16px',
              borderRadius: 'var(--radius-md)',
              padding: 8,
              maxWidth: '100%',
            }}>
              <img
                src={`data:${image.mimeType};base64,${image.base64}`}
                alt={fileName}
                style={{ maxWidth: '100%', maxHeight: 'calc(100vh - 200px)', display: 'block', borderRadius: 'var(--radius-sm)' }}
              />
            </div>
            <div style={{ marginTop: 12, fontSize: 'var(--font-sm)', color: 'var(--text-dim)', textAlign: 'center' }}>
              {fileName} — {image.size < 1024 ? image.size + ' B' : Math.round(image.size / 1024) + ' KB'} — {image.mimeType}
            </div>
          </div>
        )}
        {pdf && (
          <iframe
            src={`data:application/pdf;base64,${pdf.base64}`}
            title={fileName}
            style={{ width: '100%', height: '100%', border: 'none' }}
          />
        )}
      </div>
    </div>
  );
}
