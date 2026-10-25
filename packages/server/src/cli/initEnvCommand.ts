import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { hubEnvFilePath } from '../modules/system/misao/misaoPaths';
import type { SecretFileGuard } from '../shared/os/secretFileGuard';

const DEFAULT_PORT = 3001;
const USAGE = 'Usage: azito-hub init-env --prefix <dir> [--port <1-65535>] [--tailscale-dns <MagicDNS name>]';

export interface HubEnvOptions {
  dataDir: string;
  uiToken: string;
  /** Port the hub listens on (`PORT`); the allowed origins name the same port. */
  port: number;
  /** MagicDNS name of this host when Tailscale reported one (no trailing dot). */
  tailscaleDns: string | undefined;
}

/**
 * The text of a new `hub/.env` (the same keys install.sh writes). Values are raw: run.ps1 and the hub read this file with the
 * same parser (`readEnvValue`: no escaping, matching quotes stripped), so a Windows path needs no quoting.
 */
export function renderHubEnv(options: HubEnvOptions): string {
  const origins = [`http://localhost:${options.port}`, `http://127.0.0.1:${options.port}`];
  if (options.tailscaleDns) origins.push(`https://${options.tailscaleDns}`, `http://${options.tailscaleDns}:${options.port}`);
  const publicUrlLine = options.tailscaleDns ? `AZITO_PUBLIC_URL=https://${options.tailscaleDns}` : '# AZITO_PUBLIC_URL=https://your-host.ts.net';
  return [
    `AZITO_DATA_DIR=${options.dataDir}`,
    `AZITO_UI_TOKEN=${options.uiToken}`,
    `PORT=${options.port}`,
    '# Origins allowed for CORS and WebSocket. Add entries here when you reach AZITO',
    '# from a new hostname, then restart the hub.',
    `AZITO_ALLOWED_ORIGINS=${origins.join(',')}`,
    '# Listen address. Default is 127.0.0.1 — keep it and use a reverse proxy',
    '# (e.g. tailscale serve) for remote access. 0.0.0.0 is rejected.',
    '#AZITO_BIND=127.0.0.1',
    '# URL that supervisors and remote agents use to reach this hub.',
    '# When using tailscale serve, set this to your MagicDNS HTTPS URL (e.g. https://myhost.ts.net).',
    publicUrlLine,
    '',
  ].join('\n');
}

interface ParsedArgs {
  prefix: string;
  port: number;
  tailscaleDns: string | undefined;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) throw new Error(`--port must be a number from 1 to 65535: ${value}`);
  return port;
}

function parseArgs(args: string[]): ParsedArgs {
  let prefix: string | undefined;
  let port = DEFAULT_PORT;
  let tailscaleDns: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (value === undefined || value === '') throw new Error(`${args[i]} needs a value. ${USAGE}`);
    if (args[i] === '--prefix') prefix = value;
    else if (args[i] === '--port') port = parsePort(value);
    else if (args[i] === '--tailscale-dns') tailscaleDns = value.replace(/\.$/, '');
    else throw new Error(`Unknown option ${args[i]}. ${USAGE}`);
  }
  if (!prefix) throw new Error(USAGE);
  if (!path.isAbsolute(prefix)) throw new Error(`--prefix must be an absolute path: ${prefix}`);
  return { prefix, port, tailscaleDns };
}

/**
 * `azito-hub init-env`: what an installer needs from the hub's own code to lay down a first configuration. Creates the
 * protected data directory and, when `<prefix>/hub/.env` does not exist yet, that file with a fresh UI token. Both go through
 * the SecretFileGuard, so the access rules (owner-only DACL on Windows, mode 600 / 700 elsewhere) stay in one place instead of
 * being re-implemented in the installer script. An existing `.env` is never touched.
 */
export function initEnvCommand(args: string[], guard: SecretFileGuard): void {
  const { prefix, port, tailscaleDns } = parseArgs(args);
  const dataDir = path.join(prefix, 'data');
  guard.ensureProtectedDir(dataDir);

  const envFile = hubEnvFilePath(prefix);
  if (fs.existsSync(envFile)) {
    console.log(`${envFile} already exists, keeping it.`);
    return;
  }
  guard.writeSecretFile(envFile, renderHubEnv({ dataDir, uiToken: crypto.randomBytes(32).toString('hex'), port, tailscaleDns }));
  console.log(`Created ${envFile}`);
}
