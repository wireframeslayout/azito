import { lazy, Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { BinaryFilesBackend } from '../files/backend/FilesBackend';
import { Button } from '../ui';
import { filePreviewKind } from './filePreviewKind';
import { useBinaryFileDocument } from './useBinaryFileDocument';
import { PreviewErrorBoundary } from './PreviewErrorBoundary';

const CsvTableEditor = lazy(() => import('./CsvTableEditor').then((module) => ({ default: module.CsvTableEditor })));
const XlsxSheetEditor = lazy(() => import('./XlsxSheetEditor').then((module) => ({ default: module.XlsxSheetEditor })));
const DocxView = lazy(() => import('./DocxView').then((module) => ({ default: module.DocxView })));
const PptxView = lazy(() => import('./PptxView').then((module) => ({ default: module.PptxView })));
const MediaView = lazy(() => import('./MediaView').then((module) => ({ default: module.MediaView })));

interface Props { backend: BinaryFilesBackend; path: string; name: string; onDirtyChange?: (dirty: boolean) => void; download: () => void; headerActions?: ReactNode }
function OfficeView({ backend, path, kind }: Pick<Props, 'backend' | 'path'> & { kind: 'docx' | 'pptx' }) {
  const { t } = useTranslation('files');
  const doc = useBinaryFileDocument(backend, path);
  if (doc.loading) return <p role="status">{t('preview.loading')}</p>;
  if (doc.error || !doc.bytes) return <p role="alert">{t(doc.error === 'preview_too_large' ? 'office.tooLarge' : 'preview.loadError')}</p>;
  if (!doc.bytes.length) return <p>{t('office.empty')}</p>;
  return kind === 'docx' ? <DocxView bytes={doc.bytes} /> : <PptxView bytes={doc.bytes} />;
}
export function PreviewSwitch({ backend, path, name, onDirtyChange, download, headerActions }: Props) {
  const { t } = useTranslation('files');
  const kind = filePreviewKind(name);
  return <section style={{ height: '100%', overflow: 'auto', minWidth: 0 }}>
    <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-3)', borderBottom: '1px solid var(--border)' }}><strong style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{name}</strong><Button onClick={download}>{t('explorer.download')}</Button>{headerActions}</header>
    <PreviewErrorBoundary key={`${backend.source}:${path}`} fallback={<p role="alert">{t('preview.loadError')}</p>}><Suspense fallback={<p role="status">{t('preview.loading')}</p>}>
      {kind === 'csv' && <CsvTableEditor backend={backend} path={path} onDirtyChange={onDirtyChange} />}
      {kind === 'xlsx' && <XlsxSheetEditor backend={backend} path={path} onDirtyChange={onDirtyChange} />}
      {(kind === 'docx' || kind === 'pptx') && <OfficeView backend={backend} path={path} kind={kind} />}
      {(kind === 'video' || kind === 'audio') && <MediaView backend={backend} path={path} type={kind} />}
      {kind === 'legacy' && <p>{t('office.legacy')}</p>}
    </Suspense></PreviewErrorBoundary>
  </section>;
}
