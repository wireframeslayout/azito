import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface HubEnv {
  url: string;
  token: string;
}

export type HubEnvResult =
  | { ok: true; env: HubEnv }
  | { ok: false; missing: ('AZITO_URL' | 'AZITO_WEBHOOK_TOKEN')[] };

/**
 * The prefix grammar of harness/setup.mjs (PREFIX_PATTERN in harness/lib/claudeSettings.mjs plus its `..` check), the same as the hub's
 * (packages/server/src/app/harnessPrefix.ts); env.test.ts compares it with setup.mjs's.
 */
const VALID_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Returns the path to the azitoctl env file selected by `AZITO_PREFIX`:
 * `~/.azito/azitoctl-<prefix>.env` when the prefix is valid, `~/.azito/azitoctl.env`
 * when there is none. Same convention as `harness/setup.sh`'s hook commands
 * (`azitoctl${AZITO_PREFIX:+-$AZITO_PREFIX}.env`).
 * A prefix of an invalid shape selects no file (null): it must not fall back to the unprefixed
 * file, which belongs to another hub.
 */
export function resolveEnvFilePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const prefix = env.AZITO_PREFIX ?? '';
  if (prefix && (!VALID_PREFIX.test(prefix) || prefix.includes('..'))) return null;
  return path.join(os.homedir(), '.azito', `azitoctl${prefix ? `-${prefix}` : ''}.env`);
}

/**
 * Resolves AZITO_URL / AZITO_WEBHOOK_TOKEN as a pair (the same rule as the hooks and azitoctl): both from
 * the process env when it has both, otherwise both from the azitoctl env file selected by `AZITO_PREFIX`
 * (written by harness/setup.sh with `printf 'KEY=%q\n'`). The env's values are not mixed with the file's,
 * so the file's token is never sent to a URL that is not the file's.
 *
 * Never throws: any resolution failure (missing file, unreadable, missing
 * values) returns null, in which case the supervisor runs pass-through only
 * (no hub WebSocket).
 */
export function resolveHubEnv(
  env: NodeJS.ProcessEnv = process.env,
  envFilePath: string | null = resolveEnvFilePath(env),
): HubEnvResult {
  if (env.AZITO_URL && env.AZITO_WEBHOOK_TOKEN) return { ok: true, env: { url: env.AZITO_URL, token: env.AZITO_WEBHOOK_TOKEN } };
  let fileValues: Record<string, string> = {};
  try {
    if (envFilePath !== null && fs.existsSync(envFilePath)) {
      fileValues = parseEnvFile(fs.readFileSync(envFilePath, 'utf-8'));
    }
  } catch {
    fileValues = {};
  }

  const url = fileValues.AZITO_URL;
  const token = fileValues.AZITO_WEBHOOK_TOKEN;
  if (url && token) return { ok: true, env: { url, token } };
  const missing: ('AZITO_URL' | 'AZITO_WEBHOOK_TOKEN')[] = [];
  if (!url) missing.push('AZITO_URL');
  if (!token) missing.push('AZITO_WEBHOOK_TOKEN');
  return { ok: false, missing };
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

/**
 * Resolves the mux pane reference from environment variables.
 * tmux injects `TMUX_PANE` (format `%<digits>`).
 */
export function resolveMuxPaneRef(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (/^%\d+$/.test(env.TMUX_PANE ?? '')) return env.TMUX_PANE;
  return undefined;
}
