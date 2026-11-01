import { useTranslation } from 'react-i18next';
import { Button } from '../ui';

interface StorageSelectionActionsProps {
  count: number;
  busy: boolean;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
  onClear: () => void;
}

export function StorageSelectionActions({ count, busy, onRename, onMove, onDelete, onClear }: StorageSelectionActionsProps) {
  const { t } = useTranslation('storage');
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
    <Button size="sm" type="button" disabled={busy || count !== 1} onClick={onRename}>{t('list.rename')}</Button>
    <Button size="sm" type="button" disabled={busy} onClick={onMove}>{t('list.move')}</Button>
    <Button size="sm" variant="danger" type="button" disabled={busy} onClick={onDelete}>{t('list.delete')}</Button>
    <Button size="sm" variant="ghost" type="button" onClick={onClear}>{t('list.clearSelection')}</Button>
  </div>;
}
