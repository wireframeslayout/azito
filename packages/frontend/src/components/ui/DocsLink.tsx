import { useTranslation } from 'react-i18next';
import { buildDocsUrl, type DocsPage } from '../../lib/docsUrl';
import { Icon } from './Icon';

interface DocsLinkProps {
  /** Which docs page to link to (`docs/{ja|en}/<page>.md` on GitHub). */
  page: DocsPage;
  /** Overrides the default i18n label (`common:docs.learnMore`). */
  label?: string;
}

/**
 * External link to a repository docs page, following the current display
 * language (see `buildDocsUrl`). Styling matches the existing external-link
 * pattern used for issue/PR links (TaskGitTab.tsx) — accent color, no
 * underline, trailing `external-link` icon. `font-size: inherit` so it drops
 * into a Notice `sub` line or an inline explanatory sentence without
 * fighting the surrounding text size.
 */
export function DocsLink({ page, label }: DocsLinkProps) {
  const { t, i18n } = useTranslation('common');
  const href = buildDocsUrl(i18n.language, page);
  const text = label ?? t('docs.learnMore');
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        color: 'var(--accent)',
        textDecoration: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 'inherit',
      }}
    >
      {text} <Icon name="external-link" size={14} />
    </a>
  );
}
