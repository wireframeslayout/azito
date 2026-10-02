import { ISOLATION_MASKED_ENV } from './isolationMaskedEnv';

const SECRET_ENV_KEYS: ReadonlySet<string> = new Set([...Object.keys(ISOLATION_MASKED_ENV), 'AZITO_TASK_TOKEN', 'AZITO_HUB_PUSH']);
const SECRET_ENV_PREFIX = 'AZITO_SECRET_';

export interface SplitPaneEnv {
  /** Safe to persist and show (pane.info / pane.list). */
  env: Record<string, string>;
  /** Credentials and their isolation masks: must live only in the pane process. */
  ephemeralEnv: Record<string, string>;
}

/** Splits a pane's env into the part a daemon may persist and the part that must not be stored. */
export function splitPaneEnv(env: Record<string, string>): SplitPaneEnv {
  const result: SplitPaneEnv = { env: {}, ephemeralEnv: {} };
  for (const [key, value] of Object.entries(env)) {
    const isSecret = SECRET_ENV_KEYS.has(key) || key.startsWith(SECRET_ENV_PREFIX);
    (isSecret ? result.ephemeralEnv : result.env)[key] = value;
  }
  return result;
}
