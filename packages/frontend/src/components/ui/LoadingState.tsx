import { useTranslation } from 'react-i18next';

export function LoadingState({ message }: { message?: string }) {
  const { t } = useTranslation('common');
  return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--font-md)' }}>{message ?? t('states.loading')}</div>;
}
