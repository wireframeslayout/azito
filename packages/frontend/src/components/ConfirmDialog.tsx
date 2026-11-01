import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { ModalContent } from './Modal';
import { Button, Overlay } from './ui';

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
  const titleId = useId();
  return (
    <Overlay
      labelledBy={titleId}
      variant="alert"
      dismissOnBackdrop={false}
      busy={loading}
      open={open}
      onClose={onCancel}
      maxWidth={400}
    >
      <ModalContent titleId={titleId} title={title} onClose={onCancel} closeDisabled={loading} actions={
        <Button
          variant={confirmVariant}
          onClick={onConfirm}
          loading={loading}
        >
          {confirmLabel ?? t('actions.confirm')}
        </Button>
      }>
      <p style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', lineHeight: 1.5, margin: 0 }}>
        {message}
      </p>
      </ModalContent>
    </Overlay>
  );
}
