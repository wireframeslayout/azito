import type React from 'react';
import { useTranslation } from 'react-i18next';
import { parseSourceRef, buildIssueUrl } from '../lib/issueRef';
import { Chip } from './ui';

interface IssueRefChipProps {
  source?: string;
  sourceRef?: string | null;
}

/** The task's linked issue as a chip, a link when the provider's URL can be built. Nothing for an unparseable reference. */
export default function IssueRefChip({ source, sourceRef }: IssueRefChipProps): React.ReactElement | null {
  const { t } = useTranslation('tasks');
  const parsed = sourceRef ? parseSourceRef(sourceRef) : null;
  if (!parsed || !sourceRef) return null;
  const chip = <Chip tone="accent">{t('ref.issue', { number: parsed.number })}</Chip>;
  const issueUrl = source ? buildIssueUrl(source, sourceRef) : null;
  if (!issueUrl) return chip;
  return <a href={issueUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ textDecoration: 'none', color: 'inherit' }}>{chip}</a>;
}
