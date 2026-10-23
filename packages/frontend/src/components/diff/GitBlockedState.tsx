import { useTranslation } from 'react-i18next';
import { EmptyState } from '../ui/EmptyState';

/**
 * What a git view (diff, commits) shows instead of its content when git is closed on the server's host (a Windows agent
 * until #370). `reason` is the wording from `useHostFeatureBlock`; a saved tab opens to this, not to a failed request.
 */
export default function GitBlockedState({ reason }: { reason: string }) {
  const { t } = useTranslation('git');
  return (
    <div role="status" style={{ height: '100%', background: 'var(--ws-surface)' }}>
      <EmptyState title={t('blocked.title')} description={reason} />
    </div>
  );
}
