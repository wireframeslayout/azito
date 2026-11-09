import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui';
import type { BinaryFilesBackend } from '../files/backend/FilesBackend';
import { useBinaryFileDocument } from './useBinaryFileDocument';
import { parseCsv, serializeCsv, type CsvDocument } from './csvCodec';
import { DataGrid } from './DataGrid';

interface Props { backend: BinaryFilesBackend; path: string; onDirtyChange?: (dirty: boolean) => void }
const PAGE_SIZE = 100;
export function CsvTableEditor({ backend, path, onDirtyChange }: Props) {
  const { t } = useTranslation('files');
  const document = useBinaryFileDocument(backend, path, onDirtyChange);
  const [table, setTable] = useState<CsvDocument | null>(null);
  const [mode, setMode] = useState<'table' | 'text'>('table');
  const [page, setPage] = useState(0);
  const [parseError, setParseError] = useState(false);
  const [parsing, setParsing] = useState(false);
  const canSave = useRef(false);
  const parseGeneration = useRef(0);
  const [selected, setSelected] = useState({ row: 0, column: 0 });
  useEffect(() => {
    if (!document.bytes) return;
    let active = true;
    parseCsv(document.bytes).then((parsed) => { if (active) { setTable(parsed); setParseError(false); canSave.current = !parsed.truncated; } }).catch(() => { if (active) { setParseError(true); canSave.current = false; } });
    return () => { active = false; };
  }, [document.document]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (document.dirty && canSave.current) void document.save();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [document.dirty, document.save, table?.truncated, parseError]);
  const update = async (next: CsvDocument) => {
    const generation = ++parseGeneration.current;
    canSave.current = false; setParsing(true); setTable(next);
    try {
      if (!next.truncated) {
        const bytes = await serializeCsv(next);
        if (generation === parseGeneration.current) { document.changeBytes(bytes); canSave.current = true; }
      }
    } catch { if (generation === parseGeneration.current) setParseError(true); }
    finally { if (generation === parseGeneration.current) setParsing(false); }
  };
  const setCell = (row: number, column: number, value: string) => {
    if (!table) return;
    const rows = table.rows.map((cells, i) => i === row ? Array.from({ length: Math.max(cells.length, column + 1) }, (_, j) => j === column ? value : cells[j] || '') : cells);
    void update({ ...table, rows });
  };
  if (document.loading) return <p role="status">{t('preview.loading')}</p>;
  if ((document.error || parseError) && !table) return <p role="alert">{t(document.error === 'preview_too_large' ? 'office.tooLarge' : 'preview.loadError')}</p>;
  if (!table) return <p role="status">{t('preview.loading')}</p>;
  const columns = Math.max(1, ...table.rows.map((row) => row.length));
  return <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-3)', minWidth: 0 }}>
    {document.bytes?.length === 0 && <p role="status">{t('office.empty')}</p>}
    {document.error && <p role="alert">{t('office.saveError')}</p>}
    {parseError && <p role="alert">{t('preview.loadError')}</p>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center' }}>
      <Button onClick={() => setMode(mode === 'table' ? 'text' : 'table')}>{t(mode === 'table' ? 'office.textView' : 'office.tableView')}</Button>
      <label>{t('office.delimiter')} <select value={table.delimiter} onChange={(event) => { if (document.bytes) void parseCsv(document.bytes, event.target.value).then(setTable); }}><option value=",">,</option><option value="\t">{t('office.tab')}</option><option value=";">;</option><option value="|">|</option></select></label>
      <Button disabled={!document.dirty || document.saving || table.truncated || parseError || parsing} onClick={() => { if (canSave.current) void document.save(); }}>{t('office.save')}</Button>
      {document.dirty && <span role="status">{t('office.unsaved')}</span>}
    </div>
    {table.truncated && <p role="status">{t('office.truncated')}</p>}
    {document.conflict !== undefined && <div role="alert">{t('office.conflict')} <Button onClick={() => void document.reload()}>{t('office.reload')}</Button><Button disabled={table.truncated || parsing || parseError} onClick={() => { if (canSave.current) void document.save(true); }}>{t('office.overwrite')}</Button></div>}
    {mode === 'text' ? <textarea aria-label={t('office.textView')} value={new TextDecoder().decode(document.bytes ?? new Uint8Array())} readOnly={table.truncated} onChange={(event) => { const bytes = new TextEncoder().encode((table.bom ? '\ufeff' : '') + event.target.value); const generation = ++parseGeneration.current; canSave.current = false; setParsing(true); document.changeBytes(bytes); void parseCsv(bytes, table.delimiter).then((value) => { if (generation === parseGeneration.current) { setTable(value); setParseError(false); canSave.current = !value.truncated; } }).catch(() => { if (generation === parseGeneration.current) setParseError(true); }).finally(() => { if (generation === parseGeneration.current) setParsing(false); }); }} rows={15} /> : <>
      <DataGrid rows={table.rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)} rowOffset={page * PAGE_SIZE} columns={columns} disabled={table.truncated} onSelect={(row, column) => setSelected({ row, column })} onChange={setCell} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}><Button disabled={page === 0} onClick={() => setPage(page - 1)}>{t('office.previous')}</Button><span>{page + 1}</span><Button disabled={(page + 1) * PAGE_SIZE >= table.rows.length} onClick={() => setPage(page + 1)}>{t('office.next')}</Button><Button disabled={table.truncated || table.rows.length >= 5000} onClick={() => void update({ ...table, rows: [...table.rows, Array(columns).fill('')] })}>{t('office.addRow')}</Button><Button disabled={table.truncated || table.rows.length <= 1} onClick={() => { void update({ ...table, rows: table.rows.filter((_, index) => index !== selected.row) }); setPage(0); }}>{t('office.deleteRow')}</Button><Button disabled={table.truncated || columns >= 100} onClick={() => void update({ ...table, rows: table.rows.map((row) => [...Array.from({ length: columns }, (_, i) => row[i] || ''), '']) })}>{t('office.addColumn')}</Button><Button disabled={table.truncated || columns <= 1} onClick={() => void update({ ...table, rows: table.rows.map((row) => row.filter((_, col) => col !== selected.column)) })}>{t('office.deleteColumn')}</Button></div>
    </>}
  </section>;
}
