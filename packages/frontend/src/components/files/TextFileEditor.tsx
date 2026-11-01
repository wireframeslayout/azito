import { lazy, Suspense, useRef, useState } from 'react';
import { useToast } from '../../hooks/useToast';
import { useVirtualKeyboard } from '../../hooks/useVirtualKeyboard';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '../../hooks/useConfirm';
import { api } from '../../api/client';
import { useIsMobile } from '../../hooks/useIsMobile';
import { lineDiff, type DiffLine } from '../../utils/lineDiff';
import MarkdownRenderer from '../MarkdownRenderer';
import Modal from '../Modal';
import { SegmentedToggle } from '../ui/SegmentedToggle';
import { LoadingState } from '../ui';
import type { FilesBackend } from './backend/FilesBackend';
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
  const editor = <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
    <div style={{ flex: 1, minHeight: 0 }}><Suspense fallback={<LoadingState />}><CodeEditorView value={doc.content} language={doc.document?.language ?? 'text'} initialLine={initialLine} vimMode={vim} onChange={doc.change} onSave={() => void doc.save()} onInsertReady={(insert) => { insertRef.current = insert; }} onCursorChange={(line, col) => setCursor({ line, col })} onVimModeDisplay={setVimDisplay} /></Suspense></div>
    <Suspense fallback={null}><EditorStatusBar line={cursor.line} col={cursor.col} vimModeDisplay={vimDisplay} vimEnabled={vim} onVimToggle={() => setVim((previous) => { localStorage.setItem('azito-editor-vim-mode', String(!previous)); return !previous; })} saveStatus={doc.conflict !== undefined ? 'conflict' : doc.saving ? 'saving' : doc.dirty ? 'dirty' : doc.saved ? 'saved' : 'clean'} /></Suspense>
  </div>;
  return (
    <div onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void doc.save(); } }} style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, position: 'relative', background: 'var(--ws-surface)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-2)', borderBottom: '1px solid var(--border)' }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}{doc.dirty ? ' •' : ''}</span>
        {markdown && <SegmentedToggle options={options} value={currentMode} onChange={selectMode} ariaLabel={t('editor.viewMode')} />}
        <button onClick={async () => { try { const blob = await backend.download(path); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name.split(/[\\/]/).pop() || name; link.click(); URL.revokeObjectURL(url); } catch (error) { showToast(error instanceof Error ? error.message : String(error)); } }}>{t('explorer.download')}</button>
        {serverName && (['vscode', 'zed'] as const).map((editor) => <button key={editor} onClick={async () => { const result = await api<{ uri?: string }>(`/servers/${encodeURIComponent(serverName)}/editor-uri?path=${encodeURIComponent(path)}&editor=${editor}`); if (result.uri) window.location.href = result.uri; }}>{editor === 'vscode' ? 'VS Code' : 'Zed'}</button>)}
        <button className="btn-primary" disabled={!doc.dirty || doc.saving || doc.conflict !== undefined} onClick={() => void doc.save()}>{doc.saving ? t('editor.saving') : t('editor.save')}</button>
      </div>
      <div role="status" aria-live="polite">{doc.saving ? t('editor.saving') : doc.dirty ? t('editor.unsaved') : doc.saved ? t('editor.saved') : ''}</div>
      {doc.conflict !== undefined && <div role="alert" style={{ padding: 'var(--space-2)', background: 'var(--orange-a08)', color: 'var(--text)', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
        <span>{t('editor.conflict')} {doc.conflict === null ? t('editor.latestUnavailable') : doc.conflict.kind === 'unavailable' ? doc.conflict.reason : ''}</span><button onClick={showDiff}>{t('editor.diff')}</button><button onClick={async () => { if (await confirm({ title: t('editor.discardConfirm') })) void doc.reload(); }}>{t('editor.reload')}</button><button disabled={doc.saving} onClick={() => void doc.save(true)}>{t('editor.overwrite')}</button>
      </div>}
      {doc.error && <div role="alert" style={{ color: 'var(--danger)', padding: 'var(--space-2)' }}>{doc.error} {(!doc.document && !doc.loading) && <button onClick={() => void doc.reload()}>{t('editor.retry')}</button>}</div>}
      {doc.loading && <LoadingState />}
      {!doc.loading && doc.document && <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        {(!markdown || currentMode !== 'preview') && <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>{editor}</div>}
        {markdown && currentMode !== 'source' && <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: 'var(--space-4)' }}><MarkdownRenderer content={doc.content} /></div>}
      </div>}
      {mobile && keyboardVisible && markdown && currentMode === 'source' && <div style={{ display: 'flex', overflowX: 'auto', gap: 'var(--space-1)' }}>{['# ', '**', '*', '- ', '[ ]', '[]()', '`', '> '].map((key) => <button key={key} onPointerDown={(event) => event.preventDefault()} onClick={() => insertRef.current?.(key)}>{key}</button>)}</div>}
      {diff !== undefined && <Modal open title={t('editor.diff')} onClose={() => setDiff(undefined)} maxWidth={mobile ? '100vw' : '90vw'} maxHeight={mobile ? '100vh' : '90vh'}>
        {diff === null ? <p>{t('editor.diffUnavailable')}</p> : <pre>{diff.map((line, index) => <div key={index} style={{ color: line.kind === 'added' ? 'var(--success)' : line.kind === 'removed' ? 'var(--danger)' : 'var(--text)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}{line.text}</div>)}</pre>}
      </Modal>}
    </div>
  );
}
