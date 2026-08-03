import { parseSourceRef, buildIssueUrl } from '../lib/issueRef';
import { Chip } from './ui';
import { useTranslation } from 'react-i18next';

interface TaskRefBadgesProps {
  taskId: number;
  sourceRef?: string | null;
  source?: string;
  prUrl?: string | null;
}

function extractPrNumber(prUrl: string): string | null {
  const match = prUrl.match(/\/(?:pull|merge_requests)\/(\d+)/);
  return match ? match[1] : null;
}

const linkStyle: React.CSSProperties = {
  textDecoration: 'none',
  color: 'inherit',
};

export default function TaskRefBadges({ taskId, sourceRef, source, prUrl }: TaskRefBadgesProps) {
  const { t } = useTranslation('tasks');
  const parsed = sourceRef ? parseSourceRef(sourceRef) : null;
  const issueUrl = sourceRef && source ? buildIssueUrl(source, sourceRef) : null;
  const prNumber = prUrl ? extractPrNumber(prUrl) : null;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      <Chip>#{taskId}</Chip>
      {parsed && (
        issueUrl ? (
          <a
            href={issueUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={linkStyle}
          >
            <Chip tone="accent">{t('ref.issue', { number: parsed.number })}</Chip>
          </a>
        ) : (
          <Chip tone="accent">{t('ref.issue', { number: parsed.number })}</Chip>
        )
      )}
      {prNumber && prUrl && (
        <a
          href={prUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={linkStyle}
        >
          <Chip tone="green">{t('ref.pr', { number: prNumber })}</Chip>
        </a>
      )}
    </span>
  );
}
