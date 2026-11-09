import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Workbook, type WorkbookInstance } from '@fortune-sheet/react';
import fortuneStyles from '@fortune-sheet/react/dist/index.css?inline';
import { transformExcelToFortune, transformFortuneToExcel } from '@corbe30/fortune-excel';
import type { ComponentProps } from 'react';
import { Button } from '../ui';
import ConfirmDialog from '../ConfirmDialog';
import type { BinaryFilesBackend } from '../files/backend/FilesBackend';
import { useBinaryFileDocument } from './useBinaryFileDocument';
import { prepareXlsx } from './prepareXlsx';

type Sheets = ComponentProps<typeof Workbook>['data'];
interface Props { backend: BinaryFilesBackend; path: string; onDirtyChange?: (dirty: boolean) => void }
export function XlsxSheetEditor({ backend, path, onDirtyChange }: Props) {
  const { t } = useTranslation('files');
  const document = useBinaryFileDocument(backend, path, onDirtyChange);
  const workbook = useRef<WorkbookInstance>(null);
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  const baseline = useRef<string | null>(null);
  const lastSnapshot = useRef<string | null>(null);
  const editingRef = useRef(false);
  const [sheets, setSheets] = useState<Sheets | null>(null);
  const [key, setKey] = useState(0);
  const [editing, setEditing] = useState(false);
  editingRef.current = editing;
  const [confirm, setConfirm] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [oversized, setOversized] = useState(false);
  const [losses, setLosses] = useState<string[]>([]);
  const [error, setError] = useState<'large' | 'invalid' | null>(null);
  const [exportError, setExportError] = useState(false);
  const [changed, setChanged] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const onChange = (event: MediaQueryListEvent) => { setIsMobile(event.matches); if (event.matches) setConfirm(false); };
    setIsMobile(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  useEffect(() => { if (document.saved) { baseline.current = lastSnapshot.current; setChanged(false); dirtyCallback.current?.(false); } }, [document.saved]);
  const onWorkbookChange = useCallback((next: Sheets) => {
    setSheets(next);
    setOversized(next.some((sheet) => sheet.data?.some((row, r) => row.some((cell, c) => cell != null && (r >= 5000 || c >= 100)))));
    if (editingRef.current) {
      const snapshot = JSON.stringify(next);
      lastSnapshot.current = snapshot;
      if (baseline.current === null) baseline.current = snapshot;
      const dirty = baseline.current !== snapshot;
      setChanged(dirty); dirtyCallback.current?.(dirty);
    }
  }, []);
  useEffect(() => {
    if (!document.bytes) return;
    let active = true;
    setSheets(null); setEditing(false); setError(null); setChanged(false); setOversized(false);
    void (async () => {
      const prepared = await prepareXlsx(document.bytes!.slice().buffer);
      if (!active) return;
      setTruncated(prepared.truncated); setLosses(prepared.losses);
      await transformExcelToFortune(new File([prepared.data], 'workbook.xlsx'), (value: Sheets) => {
        if (!active) return;
        setSheets(value.map((sheet) => ({ ...sheet, celldata: sheet.celldata?.map((cell) => {
          if (!cell.v) return cell;
          const original = prepared.values[sheet.name]?.[`${cell.r}:${cell.c}`];
          const normalized = original !== undefined && (typeof original === 'boolean' || !cell.v.ct) ? { ...cell.v, v: original } : cell.v;
          return { ...cell, v: normalized.f && normalized.v == null ? { ...normalized, v: 0 } : normalized };
        }) })));
      }, setKey, { current: null });
    })().catch((reason: unknown) => { if (active) setError(reason instanceof Error && /limit|too many entries/i.test(reason.message) ? 'large' : 'invalid'); });
    return () => { active = false; };
  }, [document.loadRevision]);
  const save = async (force = false) => {
    if (!workbook.current || truncated || oversized || exportingRef.current) return;
    exportingRef.current = true; setExporting(true);
    try {
      setExportError(false);
      const blob = await transformFortuneToExcel(workbook, undefined, false);
      document.changeBytes(new Uint8Array(await blob.arrayBuffer()));
      await document.save(force);
    } catch { setExportError(true); }
    finally { exportingRef.current = false; setExporting(false); }
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (editing && changed && !truncated && !oversized) void save();
    }
  };
  if (error || (document.error && !sheets)) return <p role="alert">{t(error === 'large' || document.error === 'preview_too_large' ? 'office.tooLarge' : 'preview.loadError')}</p>;
  if (document.loading || !sheets) return <p role="status">{t('preview.loading')}</p>;
  return <section onKeyDown={onKeyDown} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
    {(document.error || exportError) && <p role="alert">{t('office.saveError')}</p>}
    <p style={{ padding: 'var(--space-2)', color: 'var(--text)' }}>{t('office.xlsxWarning')}</p>
    {isMobile && <p role="status" style={{ padding: 'var(--space-2)', color: 'var(--text)' }}>{t('office.xlsxMobile')}</p>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', padding: 'var(--space-2)' }}>
      <Button disabled={editing || truncated || isMobile} onClick={() => setConfirm(true)}>{t('office.edit')}</Button>
      <Button disabled={!editing || !changed || truncated || oversized || exporting || document.saving} onClick={() => void save()}>{t('office.save')}</Button>
      {changed && <span role="status">{t('office.unsaved')}</span>}
      {(truncated || oversized) && <span role="status">{t('office.truncated')}</span>}
    </div>
    <ConfirmDialog open={confirm} title={t('office.edit')} message={`${t('office.formatWarning')} ${losses.map((loss) => t(`office.loss.${loss}`)).join(', ')}`} confirmLabel={t('office.edit')} confirmVariant="primary" onConfirm={() => { if (workbook.current) setSheets(workbook.current.getAllSheets().map((sheet) => ({ ...sheet, celldata: sheet.data?.flatMap((row, r) => row.flatMap((cell, c) => cell ? [{ r, c, v: cell }] : [])) }))); baseline.current = null; setEditing(true); setConfirm(false); }} onCancel={() => setConfirm(false)} />
    {document.conflict !== undefined && <div role="alert">{t('office.conflict')} <Button onClick={() => void document.reload()}>{t('office.reload')}</Button><Button disabled={truncated || oversized} onClick={() => void save(true)}>{t('office.overwrite')}</Button></div>}
    {sheets && <div className="xlsx-workbook" style={{ flex: 1, minHeight: '40vh' }}><style>{`@scope (.xlsx-workbook) { ${fortuneStyles} .fortune-container { color: #222; background: #fff; } }`}</style><Workbook key={`${key}-${editing}`} ref={workbook} data={sheets} allowEdit={editing && !isMobile && !exporting} onChange={onWorkbookChange} /></div>}
  </section>;
}
