import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface HubEnv {
  url: string;
  token: string;
}

const VALID_PREFIX = /^[a-z0-9-]+$/;

/**
 * Returns the path to the azitoctl env file selected by `AZITO_PREFIX`:
 * `~/.azito/azitoctl-<prefix>.env` when the prefix is valid, otherwise
 * `~/.azito/azitoctl.env`. Same convention as `harness/setup.sh`'s hook
 * commands (`azitoctl${AZITO_PREFIX:+-$AZITO_PREFIX}.env`).
 */
export function resolveEnvFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const prefix = env.AZITO_PREFIX && VALID_PREFIX.test(env.AZITO_PREFIX) ? env.AZITO_PREFIX : '';
  return path.join(os.homedir(), '.azito', `azitoctl${prefix ? `-${prefix}` : ''}.env`);
}

/**
 * Resolves AZITO_URL / AZITO_WEBHOOK_TOKEN, preferring process env vars and
 * falling back to the azitoctl env file selected by `AZITO_PREFIX` (written
 * by harness/setup.sh with `printf 'KEY=%q\n'`).
 *
 * Never throws: any resolution failure (missing file, unreadable, missing
 * values) returns null, in which case the supervisor runs pass-through only
 * (no hub WebSocket).
 */
export function resolveHubEnv(
  env: NodeJS.ProcessEnv = process.env,
  envFilePath: string = resolveEnvFilePath(env),
): HubEnv | null {
  let fileValues: Record<string, string> = {};
  try {
    if (fs.existsSync(envFilePath)) {
      fileValues = parseEnvFile(fs.readFileSync(envFilePath, 'utf-8'));
    }
  } catch {
    fileValues = {};
  }

  const url = env.AZITO_URL || fileValues.AZITO_URL;
  const token = env.AZITO_WEBHOOK_TOKEN || fileValues.AZITO_WEBHOOK_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

/**
 * Parses `KEY=value` lines where value is bash `printf %q` quoted.
 * Only backslash escapes are decoded (`\ ` -> ` `, `\'` -> `'`, etc.).
 * The `$'...'` ANSI-C quoting form (emitted by %q only when the value contains
 * control characters) is intentionally NOT handled — URL/token values never
 * contain control characters in practice, and such a line is left as-is.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const raw = line.slice(eq + 1);
    values[key] = decodePercentQ(raw);
  }
  return values;
}

function decodePercentQ(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}
