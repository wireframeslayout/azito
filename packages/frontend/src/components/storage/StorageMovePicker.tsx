import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { StorageFilesBackend } from '../files/backend/StorageFilesBackend';
import { useStorageEntries } from './useStorageEntries';

interface Props { backend: StorageFilesBackend; initialPath: string; disabled: boolean; onMove: (path: string) => void; onCancel: () => void }
export function StorageMovePicker({ backend, initialPath, disabled, onMove, onCancel }: Props) {
  const { t } = useTranslation('storage');
  const [path, setPath] = useState(initialPath);
  const { entries, loading, error, nextCursor, loadMore, refresh } = useStorageEntries(backend, path);
  const parent = path.replace(/\/$/, '').split('/').slice(0, -1).join('/');
  return <div role="dialog" aria-label={t('list.moveDestination')} style={{ padding: 'var(--space-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg)' }}>
    <div>{t('list.moveDestination')}: /{path}</div>
    {path && <button type="button" onClick={() => setPath(parent ? `${parent}/` : '')}>{t('list.parent')}</button>}
    {loading && <div role="status">{t('list.loading')}</div>}
    {error && <div role="alert">{error} <button onClick={() => void refresh()}>{t('retry')}</button></div>}
    {entries.filter((entry) => entry.type === 'directory').map((entry) => <div key={entry.path}><button type="button" onClick={() => setPath(entry.path)}>{entry.name}/</button></div>)}
    {nextCursor && <button type="button" onClick={() => void loadMore()}>{t('list.loadMore')}</button>}
    <button type="button" disabled={disabled} onClick={() => onMove(path)}>{t('list.moveHere')}</button>{' '}
    <button type="button" onClick={onCancel}>{t('list.cancel')}</button>
  </div>;
}
