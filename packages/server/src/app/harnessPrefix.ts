/**
 * The prefix grammar of harness/setup.mjs (`PREFIX_PATTERN` in harness/lib/claudeSettings.mjs, plus its `..` check): letters, digits and
 * `. _ -`, starting with a letter or digit, never containing `..`. The same rule is in packages/tui-supervisor/src/env.ts; each package
 * has its own copy and a test compares both with setup.mjs's. Anything else (`/`, spaces, ...) is unsafe in a file name
 * (`harness-<prefix>`, `azitoctl-<prefix>.env`).
 */
const HARNESS_PREFIX_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidHarnessPrefix(prefix: string): boolean {
  return HARNESS_PREFIX_SHAPE.test(prefix) && !prefix.includes('..');
}

/** Resolves `AZITO_HARNESS_PREFIX` ('' = none). Throws when it is set to something that is not a valid prefix. */
export function resolveHarnessPrefix(raw: string | undefined): string {
  const prefix = raw ?? '';
  if (prefix !== '' && !isValidHarnessPrefix(prefix)) {
    throw new Error(`AZITO_HARNESS_PREFIX "${prefix}" is invalid: use letters, digits and . _ - only, starting with a letter or digit and without ".." (it names ~/.azito/harness-<prefix> and azitoctl-<prefix>.env)`);
  }
  return prefix;
}
