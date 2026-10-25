import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { HarnessInstaller } from './HarnessInstaller';
import type { IServerRepository, ServerConfig } from '../Server';
import type { KeyedMutex } from '../../../shared/keyedMutex';
import type { TransportFactory } from '../transport/TransportFactory';
import type { IFileOps } from '../../../shared/fs/fileOps';
import { harnessLocation, homeDirOf, readTextIfPresent } from './harnessLocation';
import { buildHarnessInstallOptions } from './harnessInstallOptions';
import { resolveRoot } from '../../../shared/releaseInfo';

const HARNESS_DIR = path.join(resolveRoot(), 'harness');

const EXCLUDE = new Set(['node_modules', '.git']);

export interface HarnessUpdateResult {
  name: string;
  status: 'up_to_date' | 'updated' | 'error' | 'skipped';
  message?: string;
  at?: string;
}

export interface HarnessUpdaterOptions {
  webhookToken: string;
  uiToken: string;
  harnessPrefix?: string;
}

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

export class HarnessUpdater {
  private harnessHash: string | null = null;
  private lastResults = new Map<string, HarnessUpdateResult>();

  constructor(
    private harnessInstaller: HarnessInstaller,
    private transportFactory: Pick<TransportFactory, 'getAgentTransport'>,
    private serverRepo: IServerRepository,
    private options: HarnessUpdaterOptions,
    private serverIsolationMutex: KeyedMutex,
    private logger: Logger,
  ) {}

  getHarnessHash(): string {
    if (!this.harnessHash) {
      this.harnessHash = computeHarnessHash(HARNESS_DIR);
    }
    return this.harnessHash;
  }

  getLastResult(serverName: string): HarnessUpdateResult | undefined {
    return this.lastResults.get(serverName);
  }

  async checkAllServers(): Promise<HarnessUpdateResult[]> {
    const servers = this.serverRepo.findAll().filter((s) => s.type === 'agent');
    const results: HarnessUpdateResult[] = [];
    for (const server of servers) results.push(await this.checkAndUpdate(server));
    return results;
  }

  async checkAndUpdate(server: ServerConfig): Promise<HarnessUpdateResult> {
    if (server.type !== 'agent') {
      return { name: server.name, status: 'up_to_date' };
    }

    // A Unix agent is updated over SSH (setup.sh); a Windows one through the agent itself (setup.mjs), which needs no SSH.
    const isWindows = server.hostProfile?.platform === 'win32';
    const sshHost = server.sshHost || null;
    if (!isWindows && !sshHost) {
      const r: HarnessUpdateResult = {
        name: server.name, status: 'skipped',
        message: 'No SSH host configured', at: new Date().toISOString(),
      };
      this.lastResults.set(server.name, r);
      return r;
    }

    const prefix = this.options.harnessPrefix;
    const localHash = this.getHarnessHash();

    let azitoUrl: string | undefined;
    let remoteVersion: string | undefined;
    try {
      const files = this.transportFactory.getAgentTransport(server).files();
      const location = harnessLocation(files.platform, await homeDirOf(files), prefix);
      azitoUrl = await readRemoteAzitoUrl(files, location.envFile);
      remoteVersion = (await readTextIfPresent(files, location.versionFile))?.trim() || undefined;
    } catch (err) {
      const r: HarnessUpdateResult = {
        name: server.name, status: 'skipped',
        message: `Could not read the installed harness: ${(err as Error).message}`,
        at: new Date().toISOString(),
      };
      this.lastResults.set(server.name, r);
      return r;
    }
    if (!azitoUrl) {
      const r: HarnessUpdateResult = {
        name: server.name, status: 'skipped',
        message: 'AZITO_URL not found in azitoctl env; manual reinstall required',
        at: new Date().toISOString(),
      };
      this.lastResults.set(server.name, r);
      return r;
    }

    if (remoteVersion === localHash) {
      const r: HarnessUpdateResult = { name: server.name, status: 'up_to_date' };
      this.lastResults.set(server.name, r);
      return r;
    }

    return this.serverIsolationMutex.withLock(server.name, async () => {
      const srv = this.serverRepo.findByName(server.name);
      if (!srv || srv.type !== 'agent') {
        const r: HarnessUpdateResult = {
          name: server.name, status: 'skipped',
          message: 'Server no longer exists or is not an agent server',
          at: new Date().toISOString(),
        };
        this.lastResults.set(server.name, r);
        return r;
      }

      const installOptions = buildHarnessInstallOptions(srv, srv.hostProfile, this.options, {
        azitoUrl,
        version: localHash,
      });

      try {
        const result = installOptions.hostProfile?.platform === 'win32'
          ? await this.harnessInstaller.installOnAgent(this.transportFactory.getAgentTransport(srv), installOptions)
          : await this.harnessInstaller.install(sshHost!, installOptions);
        if (!result.success) {
          const r: HarnessUpdateResult = {
            name: server.name, status: 'error',
            message: result.error ?? 'Install failed', at: new Date().toISOString(),
          };
          this.lastResults.set(server.name, r);
          return r;
        }
        const r: HarnessUpdateResult = {
          name: server.name, status: 'updated', at: new Date().toISOString(),
        };
        this.lastResults.set(server.name, r);
        return r;
      } catch (err) {
        const r: HarnessUpdateResult = {
          name: server.name, status: 'error',
          message: (err as Error).message, at: new Date().toISOString(),
        };
        this.lastResults.set(server.name, r);
        return r;
      }
    });
  }
}

/**
 * The hub URL a harness install wrote into `azitoctl*.env`. setup.sh writes `AZITO_URL=<shell-quoted value>`, setup.mjs (Windows)
 * `AZITO_URL="<JSON string>"`. A value in neither form is not guessed at: it reads as absent.
 */
export function parseAzitoUrl(envText: string): string | undefined {
  const match = envText.match(/^AZITO_URL=(.+?)\r?$/m);
  if (!match) return undefined;
  const raw = match[1];
  if (raw.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'string' && parsed ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  // Remove shell quoting ($'...' or unquoted)
  return raw.replace(/^\$?'(.*)'$/, '$1');
}

async function readRemoteAzitoUrl(files: IFileOps, envFile: string): Promise<string | undefined> {
  const text = await readTextIfPresent(files, envFile);
  return text === null ? undefined : parseAzitoUrl(text);
}

export function computeHarnessHash(harnessDir: string): string {
  const entries: string[] = [];
  collectFiles(harnessDir, '', entries);
  entries.sort();

  const hash = crypto.createHash('sha256');
  for (const entry of entries) {
    hash.update(entry);
    hash.update('\0');
    const content = fs.readFileSync(path.join(harnessDir, entry));
    hash.update(content);
  }
  return hash.digest('hex').slice(0, 16);
}

function collectFiles(base: string, rel: string, out: string[]): void {
  const entries = fs.readdirSync(path.join(base, rel), { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDE.has(entry.name)) continue;
    if (entry.name === 'VERSION') continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      collectFiles(base, relPath, out);
    } else if (entry.isFile()) {
      out.push(relPath);
    }
  }
}
