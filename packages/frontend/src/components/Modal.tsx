import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Overlay } from './ui';

interface ModalProps {
  title: string;
  open: boolean;
  onClose: () => void;
  actions?: ReactNode;
  children: ReactNode;
  maxWidth?: number | string;
  maxHeight?: string;
  hideCancel?: boolean;
}

export function ModalContent({ title, children, actions, onClose, hideCancel = false, closeDisabled = false, titleId }: Pick<ModalProps, 'title' | 'children' | 'actions' | 'onClose' | 'hideCancel'> & { closeDisabled?: boolean; titleId: string }) {
  const { t } = useTranslation('common');
  return <>
    <h2 id={titleId} style={{ fontSize: 'var(--font-lg)', marginBottom: 'var(--space-4)' }}>{title}</h2>
    <div>{children}</div>
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
      {!hideCancel && <Button onClick={onClose} disabled={closeDisabled}>{t('actions.cancel')}</Button>}
      {actions}
    </div>
  </>;
}

export default function Modal({ title, open, onClose, actions, children, maxWidth = 500, maxHeight = '90vh', hideCancel = false }: ModalProps) {
  const titleId = useId();
  return <Overlay open={open} onClose={onClose} labelledBy={titleId} maxWidth={maxWidth} maxHeight={maxHeight}>
    <ModalContent titleId={titleId} title={title} onClose={onClose} actions={actions} hideCancel={hideCancel}>{children}</ModalContent>
  </Overlay>;
}
