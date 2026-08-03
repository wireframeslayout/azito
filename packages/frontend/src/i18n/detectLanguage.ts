type SupportedLanguage = 'ja' | 'en';

const SUPPORTED: readonly SupportedLanguage[] = ['ja', 'en'];

export function resolveInitialLanguage(
  stored: string | null,
  browserLanguages: readonly string[],
): SupportedLanguage {
  if (stored && (SUPPORTED as readonly string[]).includes(stored)) {
    return stored as SupportedLanguage;
  }

  for (const lang of browserLanguages) {
    const primary = lang.split('-')[0].toLowerCase();
    if (primary === 'ja') return 'ja';
  }

  return 'en';
}
