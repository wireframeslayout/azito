import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { StorageFilesBackend } from '../files/backend/StorageFilesBackend';
import { useStorageEntries } from './useStorageEntries';
import { Button } from '../ui';

interface Props { backend: StorageFilesBackend; initialPath: string; disabled: boolean; onMove: (path: string) => void; onCancel: () => void }
export function StorageMovePicker({ backend, initialPath, disabled, onMove, onCancel }: Props) {
  const { t } = useTranslation('storage');
  const [path, setPath] = useState(initialPath);
  const { entries, loading, error, nextCursor, loadMore, refresh } = useStorageEntries(backend, path);
  const parent = path.replace(/\/$/, '').split('/').slice(0, -1).join('/');
  return <div role="dialog" aria-label={t('list.moveDestination')} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', margin: 'var(--space-2)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', background: 'var(--bg-elevated)' }}>
    <div style={{ fontSize: 'var(--font-sm)', overflowWrap: 'anywhere' }}>{t('list.moveDestination')}: /{path}</div>
    {path && <div><Button size="sm" variant="ghost" type="button" onClick={() => setPath(parent ? `${parent}/` : '')}>{t('list.parent')}</Button></div>}
    {loading && <div role="status" style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>{t('list.loading')}</div>}
    {error && <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--danger)' }}>{error} <Button size="sm" type="button" onClick={() => void refresh()}>{t('retry')}</Button></div>}
    <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 'min(40vh, calc(var(--space-6) * 10))', overflowY: 'auto' }}>
      {entries.filter((entry) => entry.type === 'directory').map((entry) => <Button key={entry.path} size="sm" variant="ghost" type="button" onClick={() => setPath(entry.path)}>{entry.name}/</Button>)}
      {nextCursor && <Button size="sm" variant="ghost" type="button" onClick={() => void loadMore()}>{t('list.loadMore')}</Button>}
    </div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
      <Button size="sm" variant="primary" type="button" disabled={disabled} onClick={() => onMove(path)}>{t('list.moveHere')}</Button>
      <Button size="sm" variant="ghost" type="button" onClick={onCancel}>{t('list.cancel')}</Button>
    </div>
  </div>;
}
