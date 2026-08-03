import i18n from '../i18n';

// Matches a trailing timezone designator: 'Z'/'z', or a numeric offset like
// '+09:00' / '+0900' / '-05:00'. Strings that already carry one (git
// `--pretty=%aI` output, ISO strings with 'Z') must be parsed as-is; strings
// without one are naive SQLite datetimes ('YYYY-MM-DD HH:MM:SS') that have
// always been treated as UTC here, so that behavior is preserved.
const TZ_SUFFIX = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;

function parseDateString(input: string): Date {
  const trimmed = input.trim();
  if (TZ_SUFFIX.test(trimmed)) {
    return new Date(trimmed);
  }
  const asUtc = new Date(trimmed + 'Z');
  if (Number.isFinite(asUtc.getTime())) {
    return asUtc;
  }
  return new Date(trimmed);
}

export function formatRelativeTime(input: string | number | Date, language?: string): string {
  const d = typeof input === 'string' ? parseDateString(input)
    : typeof input === 'number' ? new Date(input)
    : input;

  // This is a display-only helper: an unparseable/invalid date must never
  // crash the UI (Intl.RelativeTimeFormat throws a RangeError on NaN), so
  // fall back to an empty string rather than propagating the error.
  if (!Number.isFinite(d.getTime())) {
    return '';
  }

  const diffSec = (Date.now() - d.getTime()) / 1000;
  const locale = language ?? i18n.language;

  if (diffSec < 60) {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, 'second');
  }
  if (diffSec < 3600) {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' }).format(-Math.floor(diffSec / 60), 'minute');
  }
  if (diffSec < 86400) {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' }).format(-Math.floor(diffSec / 3600), 'hour');
  }
  return new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' }).format(-Math.floor(diffSec / 86400), 'day');
}

export function timeAgo(dateStr: string): string {
  return formatRelativeTime(dateStr);
}
