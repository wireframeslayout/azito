const DOCS_BASE_URL = 'https://github.com/wireframeslayout/azito/blob/master/docs';

export type DocsPage = 'isolated-execution' | 'security-setup';

/**
 * Builds a GitHub blob URL for a docs page, choosing `ja`/`en` from the
 * current display language. Docs live only in the repository (the hub does
 * not serve them), so the link always points at GitHub rather than a local
 * route.
 *
 * `language` is matched case-insensitively against a leading `ja` (so `ja`,
 * `ja-JP`, `JA` all resolve to the Japanese doc); anything else — including
 * an unset/unknown/empty language — falls back to `en`.
 */
export function buildDocsUrl(language: string, page: DocsPage): string {
  const lang = language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
  return `${DOCS_BASE_URL}/${lang}/${page}.md`;
}
