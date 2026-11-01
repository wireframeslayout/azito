import { lazy, Suspense, useRef, useState } from 'react';
import { useToast } from '../../hooks/useToast';
import { useVirtualKeyboard } from '../../hooks/useVirtualKeyboard';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '../../hooks/useConfirm';
import { api } from '../../api/client';
import { useIsMobile } from '../../hooks/useIsMobile';
import { lineDiff, type DiffLine } from '../../utils/lineDiff';
import MarkdownRenderer from '../MarkdownRenderer';
import { LineDiffView } from './LineDiffView';
import { MarkdownKeyRow } from './MarkdownKeyRow';
import { SegmentedToggle } from '../ui/SegmentedToggle';
import { Button, LoadingState, Notice } from '../ui';
import { Icon } from '../ui/Icon';
import type { FilesBackend, TextUnavailable } from './backend/FilesBackend';
import { useTextFileDocument } from './useTextFileDocument';

const CodeEditorView = lazy(() => import('../editor/CodeEditorView'));
const EditorStatusBar = lazy(() => import('../editor/EditorStatusBar'));
type Mode = 'source' | 'preview' | 'split';

interface TextFileEditorProps {
  backend: FilesBackend;
  path: string;
  name: string;
  initialLine?: number;
  serverName?: string;
  onDirtyChange?: (dirty: boolean) => void;
}

export function TextFileEditor({ backend, path, name, initialLine, serverName, onDirtyChange }: TextFileEditorProps) {
  const { t } = useTranslation('files');
  const mobile = useIsMobile();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const keyboardVisible = useVirtualKeyboard();
  const insertRef = useRef<((text: string) => void) | null>(null);
  const [mode, setMode] = useState<Mode>(() => {
    const value = localStorage.getItem('azito-md-view-mode');
    return value === 'source' || value === 'split' || value === 'preview' ? value : 'preview';
  });
  const [vim, setVim] = useState(() => !mobile && localStorage.getItem('azito-editor-vim-mode') === 'true');
  const [vimDisplay, setVimDisplay] = useState('');
  const [cursor, setCursor] = useState({ line: initialLine ?? 1, col: 1 });
  const [diff, setDiff] = useState<DiffLine[] | null | undefined>(undefined);
  const doc = useTextFileDocument(backend, path, onDirtyChange);
  const currentMode = mobile && mode === 'split' ? 'source' : mode;
  const markdown = doc.document?.language === 'markdown';
  const options: Array<{ value: Mode; label: string }> = [
    { value: 'source', label: t('explorer.sourceView') },
    { value: 'preview', label: t('explorer.previewView') },
    ...(!mobile ? [{ value: 'split' as const, label: t('explorer.splitView') }] : []),
  ];
  const selectMode = (value: Mode) => { setMode(value); localStorage.setItem('azito-md-view-mode', value); };
  const showDiff = () => setDiff(doc.conflict?.kind === 'text' ? lineDiff(doc.conflict.content, doc.content) : null);
  const unavailableText = (value: TextUnavailable): string => value.code === 'other' ? value.message : t(`editor.unavailable.${value.code}`);
  const canSave = doc.dirty && !doc.saving && doc.conflict === undefined;
  const save = () => { if (canSave) void doc.save(); };
  const download = async () => {
    try {
      const blob = await backend.download(path);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = name.split(/[\\/]/).pop() || name;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch { showToast(t('explorer.downloadFailed')); }
  };
  const openInEditor = async (target: 'vscode' | 'zed') => {
    if (!serverName) return;
    try {
      const result = await api<{ uri?: string }>(`/servers/${encodeURIComponent(serverName)}/editor-uri?path=${encodeURIComponent(path)}&editor=${target}`);
      if (result.uri) window.location.href = result.uri;
    } catch { showToast(t('preview.loadError')); }
  };
  const editor = <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
    <div style={{ flex: 1, minHeight: 0 }}><Suspense fallback={<LoadingState />}><CodeEditorView value={doc.content} language={doc.document?.language ?? 'text'} initialLine={initialLine} vimMode={vim} onChange={doc.change} onSave={save} onInsertReady={(insert) => { insertRef.current = insert; }} onCursorChange={(line, col) => setCursor({ line, col })} onVimModeDisplay={setVimDisplay} /></Suspense></div>
    <Suspense fallback={null}><EditorStatusBar line={cursor.line} col={cursor.col} vimModeDisplay={vimDisplay} vimEnabled={vim} onVimToggle={() => setVim((previous) => { localStorage.setItem('azito-editor-vim-mode', String(!previous)); return !previous; })} saveStatus={doc.conflict !== undefined ? 'conflict' : doc.saving ? 'saving' : doc.dirty ? 'dirty' : doc.saved ? 'saved' : 'clean'} /></Suspense>
  </div>;
  return (
    <div onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); } }} style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, position: 'relative', background: 'var(--ws-surface)' }}>
      <div style={{ padding: 'var(--space-2) var(--space-4)', borderBottom: '1px solid var(--border)', background: 'var(--bg-card)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-3)', flexShrink: 0, minHeight: 40 }}>
        <Icon name="file" size={14} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--font-md)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={name}>
          {name}{doc.dirty && <span aria-label={t('editor.unsaved')} style={{ color: 'var(--accent)' }}> •</span>}
        </span>
        <Button size="sm" variant={canSave ? 'primary' : 'default'} disabled={!canSave} onClick={save} title={`${t('editor.save')} (Ctrl+S)`}>{doc.saving ? t('editor.saving') : t('editor.save')}</Button>
        {markdown && <SegmentedToggle options={options} value={currentMode} onChange={selectMode} ariaLabel={t('editor.viewMode')} />}
        <Button size="sm" variant="ghost" onClick={() => void download()} title={t('explorer.download')}><Icon name="download" size={14} /> {t('explorer.download')}</Button>
        {serverName && <>
          <Button size="sm" variant="ghost" onClick={() => void openInEditor('vscode')} title={t('explorer.openInVsCode')}>VS Code</Button>
          <Button size="sm" variant="ghost" onClick={() => void openInEditor('zed')} title={t('explorer.openInZed')}>Zed</Button>
        </>}
      </div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{doc.saving ? t('editor.saving') : doc.dirty ? t('editor.unsaved') : doc.saved ? t('editor.saved') : ''}</div>
      {doc.conflict !== undefined && <Notice tone="warning" style={{ margin: 'var(--space-2)', flexShrink: 0 }} sub={doc.conflict === null ? t('editor.latestUnavailable') : doc.conflict.kind === 'unavailable' ? unavailableText(doc.conflict) : undefined}
        action={<div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
          <Button size="sm" onClick={showDiff}>{t('editor.diff')}</Button>
          <Button size="sm" disabled={doc.saving} onClick={async () => { if (await confirm({ title: t('editor.discardConfirm'), confirmLabel: t('editor.reload'), danger: true })) void doc.reload(); }}>{t('editor.reload')}</Button>
          <Button size="sm" variant="danger" disabled={doc.saving} onClick={() => void doc.save(true)}>{t('editor.overwrite')}</Button>
        </div>}>{t('editor.conflict')}</Notice>}
      {doc.unavailable && <Notice tone="warning" style={{ margin: 'var(--space-2)', flexShrink: 0 }}
        action={<div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
          <Button size="sm" onClick={() => void download()}><Icon name="download" size={14} /> {t('explorer.download')}</Button>
          <Button size="sm" variant="ghost" onClick={() => void doc.reload()}>{t('editor.retry')}</Button>
        </div>}>{unavailableText(doc.unavailable)}</Notice>}
      {doc.error && <div role="alert" style={{ margin: 'var(--space-2)', flexShrink: 0 }}><Notice tone="danger" action={(!doc.document && !doc.loading) ? <Button size="sm" onClick={() => void doc.reload()}>{t('editor.retry')}</Button> : undefined}>{doc.error}</Notice></div>}
      {doc.loading && <LoadingState />}
      {!doc.loading && doc.document && <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        {(!markdown || currentMode !== 'preview') && <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>{editor}</div>}
        {markdown && currentMode !== 'source' && <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: 'var(--space-4)' }}><MarkdownRenderer content={doc.content} /></div>}
      </div>}
      {mobile && keyboardVisible && markdown && currentMode === 'source' && <MarkdownKeyRow onInsert={(value) => insertRef.current?.(value)} />}
      {diff !== undefined && <LineDiffView lines={diff} mobile={mobile} onClose={() => setDiff(undefined)} />}
    </div>
  );
}
