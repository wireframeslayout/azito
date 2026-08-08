import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import { Button } from '../ui';

interface DeleteTarget {
  path: string;
  type: 'file' | 'directory';
  serverName: string;
}

interface DeleteConfirmModalProps {
  target: DeleteTarget | null;
  onConfirm: () => void;
  onClose: () => void;
  loading?: boolean;
}

export default function DeleteConfirmModal({ target, onConfirm, onClose, loading }: DeleteConfirmModalProps) {
  const { t } = useTranslation('files');
  if (!target) return null;

  const isDir = target.type === 'directory';
  const title = isDir ? t('explorer.deleteFolderTitle') : t('explorer.deleteFileTitle');

  return (
    <Modal
      title={title}
      open={!!target}
      onClose={onClose}
      maxWidth={440}
      actions={
        <Button variant="danger" onClick={onConfirm} loading={loading}>
          {t('explorer.delete')}
        </Button>
      }
    >
      <div style={{ fontSize: 'var(--font-md)', lineHeight: 1.6 }}>
        <p>{isDir ? t('explorer.deleteConfirmFolder') : t('explorer.deleteConfirmFile')}</p>
        <div style={{
          marginTop: 8,
          padding: '6px 10px',
          background: 'var(--bg-input)',
          borderRadius: 'var(--radius-sm)',
          fontFamily: 'monospace',
          fontSize: 'var(--font-sm)',
          color: 'var(--danger)',
          wordBreak: 'break-all',
        }}>
          {target.path}
        </div>
        <div style={{ marginTop: 6, fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>
          {target.serverName}
        </div>
      </div>
    </Modal>
  );
}
