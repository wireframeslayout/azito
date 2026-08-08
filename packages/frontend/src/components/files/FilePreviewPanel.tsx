import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, fetchBlob } from '../../api/client';
import { useToast } from '../../hooks/useToast';
import MarkdownRenderer, { mdStyles } from '../MarkdownRenderer';
import { Icon } from '../ui/Icon';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import 'highlight.js/styles/github-dark.min.css';

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('css', css);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('sql', sql);

/* ── Types ── */

interface FileContent {
  content: string;
  path: string;
  size: number;
  language: string;
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

function HighlightedCode({ content, language, initialLine }: { content: string; language: string; initialLine?: number }) {
  const highlighted = useMemo(() => {
    const lang = language === 'text' ? undefined : language;
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(content, { language: lang }).value;
      } catch {}
    }
    try {
      return hljs.highlightAuto(content).value;
    } catch {}
    return content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }, [content, language]);

  const lines = content.split('\n');
  const targetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initialLine && targetRef.current) {
      const el = targetRef.current.querySelector(`[data-line="${initialLine}"]`);
      el?.scrollIntoView({ block: 'center' });
    }
  }, [initialLine, content]);

  return (
    <div ref={targetRef} style={{ display: 'flex', fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', 'Consolas', monospace", fontSize: 'var(--font-md)', lineHeight: 1.6 }}>
      <div style={{
        padding: '12px 12px 12px 16px',
        textAlign: 'right',
        color: 'var(--text-dim)',
        opacity: 0.4,
        userSelect: 'none',
        flexShrink: 0,
        borderRight: '1px solid var(--border)',
        whiteSpace: 'pre',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {lines.map((_, i) => {
          const lineNum = i + 1;
          const isTarget = lineNum === initialLine;
          return (
            <span
              key={lineNum}
              data-line={lineNum}
              style={isTarget ? { background: 'var(--accent-a15)', borderRadius: 2, opacity: 1 } : undefined}
            >
              {lineNum}
            </span>
          );
        })}
      </div>
      <pre
        className="hljs"
        dangerouslySetInnerHTML={{ __html: highlighted }}
        style={{
          padding: '12px 16px',
          margin: 0,
          flex: 1,
          overflow: 'auto',
          whiteSpace: 'pre',
          background: 'transparent',
          tabSize: 4,
        }}
      />
    </div>
  );
}

type MdViewMode = 'source' | 'preview' | 'split';

function MarkdownFileView({ content, language, mode }: { content: string; language: string; mode: MdViewMode }) {
  if (mode === 'source') return <HighlightedCode content={content} language={language} />;
  if (mode === 'preview') return (
    <div style={{ padding: '24px 32px', maxWidth: 900, margin: '0 auto' }}>
      <style>{mdStyles}</style>
      <MarkdownRenderer content={content} />
    </div>
  );
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ flex: 1, overflow: 'auto', borderRight: '1px solid var(--border)' }}>
        <HighlightedCode content={content} language={language} />
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '24px 32px' }}>
        <style>{mdStyles}</style>
        <MarkdownRenderer content={content} />
      </div>
    </div>
  );
}

/* ── File Preview Panel (for main area) ── */

export function FilePreviewPanel({ serverName, filePath, initialLine }: { serverName: string; filePath: string; initialLine?: number }) {
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

  const isMarkdown = file?.language === 'markdown';

  const handleMdViewMode = (mode: MdViewMode) => {
    setMdViewMode(mode);
    localStorage.setItem('azito-md-view-mode', mode);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFile(null);
    setImage(null);
    setPdf(null);
    api<FileResponse>(`/servers/${serverName}/files/content?path=${encodeURIComponent(filePath)}`)
      .then((res) => {
        if (cancelled) return;
        if (res.error) { setError(res.error); }
        else if (res.type === 'image') { setImage(res); }
        else if (res.type === 'pdf') { setPdf(res); }
        else { setFile(res as FileContent); }
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) { setError('Failed to load file'); setLoading(false); }
      });
    return () => { cancelled = true; };
  }, [serverName, filePath]);

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

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 0 }}>
        {loading && (
          <div style={{ padding: 24, color: 'var(--text-dim)', fontSize: 'var(--font-md)' }}>Loading {fileName}...</div>
        )}
        {error && (
          <div style={{ padding: 24, color: 'var(--danger)', fontSize: 'var(--font-md)' }}>{error}</div>
        )}
        {file && isMarkdown ? (
          <MarkdownFileView content={file.content} language={file.language} mode={mdViewMode} />
        ) : file ? (
          <HighlightedCode content={file.content} language={file.language} initialLine={initialLine} />
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
