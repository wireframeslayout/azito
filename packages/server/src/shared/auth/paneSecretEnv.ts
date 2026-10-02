/** Keys known to carry no credential. Any other key (task token, AZITO_SECRET_*, isolation masks, ...) stays ephemeral. */
const PERSISTABLE_ENV_KEYS: ReadonlySet<string> = new Set(['AZITO_TASK_ID', 'AZITO_AGENT_PORT']);

export interface SplitPaneEnv {
  /** Safe to persist and show (pane.info / pane.list). */
  env: Record<string, string>;
  /** Everything else: must live only in the pane process. */
  ephemeralEnv: Record<string, string>;
}

/** Splits a pane's env into the part a daemon may persist and the part that must not be stored. */
export function splitPaneEnv(env: Record<string, string>): SplitPaneEnv {
  const result: SplitPaneEnv = { env: {}, ephemeralEnv: {} };
  for (const [key, value] of Object.entries(env)) {
    (PERSISTABLE_ENV_KEYS.has(key) ? result.env : result.ephemeralEnv)[key] = value;
  }
  return result;
}
