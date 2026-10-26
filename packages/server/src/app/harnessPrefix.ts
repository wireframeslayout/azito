/**
 * The same shape packages/tui-supervisor/src/env.ts accepts for AZITO_PREFIX (`azitoctl-<prefix>.env`). A prefix of any other shape
 * would be refused there and read as no file at all, so it is refused here, once, where the hub starts (#528).
 */
const HARNESS_PREFIX_SHAPE = /^[a-z0-9-]+$/;

/** Resolves `AZITO_HARNESS_PREFIX` ('' = none). Throws when it is set to something that is not lowercase letters, digits and hyphens. */
export function resolveHarnessPrefix(raw: string | undefined): string {
  const prefix = raw ?? '';
  if (prefix !== '' && !HARNESS_PREFIX_SHAPE.test(prefix)) {
    throw new Error(`AZITO_HARNESS_PREFIX "${prefix}" is invalid: use only lowercase letters, digits and hyphens (it names ~/.azito/harness-<prefix> and azitoctl-<prefix>.env)`);
  }
  return prefix;
}
