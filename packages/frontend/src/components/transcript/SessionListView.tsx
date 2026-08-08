import { useTranslation } from 'react-i18next';
import { useApi } from '../../hooks/useApi';
import { LoadingState, EmptyState, ListRow, ListRowGroup, PageContainer, PageHeader, PageBody } from '../ui';
import { Icon } from '../ui/Icon';
import { formatRelativeTime } from '../../utils/time';
import { formatBytes, pathBasename } from './transcriptFormat';
import type { SessionSummary } from './transcriptTypes';

interface SessionListViewProps {
  onSelect: (sessionId: string) => void;
}

export default function SessionListView({ onSelect }: SessionListViewProps) {
  const { t, i18n } = useTranslation('transcript');
  const { data, loading, error } = useApi<{ sessions: SessionSummary[] }>('/transcripts');
  const sessions = data?.sessions ?? [];

  return (
    <PageContainer style={{ height: undefined, overflowY: undefined, padding: 0 }}>
      <PageHeader title={t('list.title')} count={loading ? undefined : sessions.length} />
      <PageBody>
        {loading ? (
          <LoadingState />
        ) : error ? (
          <EmptyState title={t('list.loadError')} description={error} />
        ) : sessions.length === 0 ? (
          <EmptyState title={t('list.empty')} description={t('list.emptyDescription')} />
        ) : (
          <ListRowGroup>
            {sessions.map((session) => (
              <ListRow
                key={session.sessionId}
                onClick={() => onSelect(session.sessionId)}
                ariaLabel={session.preview || session.sessionId}
                icon={<Icon name="transcript" size={16} />}
                title={session.preview || t('list.noPreview')}
                description={
                  session.cwd ? (
                    <span title={session.cwd}>{pathBasename(session.cwd)}</span>
                  ) : (
                    session.projectDir
                  )
                }
                chips={
                  <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)', whiteSpace: 'nowrap' }}>
                    {formatRelativeTime(session.mtimeMs, i18n.language)} · {formatBytes(session.sizeBytes)}
                  </span>
                }
              />
            ))}
          </ListRowGroup>
        )}
      </PageBody>
    </PageContainer>
  );
}
