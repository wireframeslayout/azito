import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import { Button } from './ui';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
  confirmLabel?: string;
  confirmVariant?: 'danger' | 'primary';
}

export default function ConfirmDialog({
  open, title, message, onConfirm, onCancel,
  loading = false,
  confirmLabel,
  confirmVariant = 'danger',
}: ConfirmDialogProps) {
  const { t } = useTranslation('common');
  return (
    <Modal
      title={title}
      open={open}
      onClose={onCancel}
      maxWidth={400}
      actions={
        <Button
          variant={confirmVariant}
          onClick={onConfirm}
          loading={loading}
        >
          {confirmLabel ?? t('actions.confirm')}
        </Button>
      }
    >
      <p style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', lineHeight: 1.5, margin: 0 }}>
        {message}
      </p>
    </Modal>
  );
}
