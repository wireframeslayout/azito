import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { HarnessInstaller } from './HarnessInstaller';
import type { IServerRepository, ServerConfig } from '../Server';
import type { KeyedMutex } from '../../../shared/keyedMutex';
import type { SshClient } from '../ssh/SshClient';
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
    private sshClient: SshClient,
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
    for (const server of servers) {
      results.push(await this.checkAndUpdate(server));
    }
    return results;
  }

  async checkAndUpdate(server: ServerConfig): Promise<HarnessUpdateResult> {
    if (server.type !== 'agent') {
      return { name: server.name, status: 'up_to_date' };
    }

    const sshHost = server.sshHost || null;
    if (!sshHost) {
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
    try {
      azitoUrl = await this.readRemoteAzitoUrl(sshHost, prefix);
    } catch {
      // SSH failure reading env — treat as no URL
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

    let remoteVersion: string | undefined;
    try {
      remoteVersion = await this.readRemoteVersion(sshHost, prefix);
    } catch {
      // VERSION file missing or unreadable — treat as outdated
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
        const result = await this.harnessInstaller.install(sshHost, installOptions);
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

  private async readRemoteAzitoUrl(sshHost: string, prefix?: string): Promise<string | undefined> {
    const envFile = `~/.azito/azitoctl${prefix ? `-${prefix}` : ''}.env`;
    const result = await this.sshClient.execIsolated(sshHost, `grep '^AZITO_URL=' ${envFile} 2>/dev/null | head -1`);
    const line = result.stdout.trim();
    if (!line) return undefined;
    const match = line.match(/^AZITO_URL=(.+)$/);
    if (!match) return undefined;
    // Remove shell quoting ($'...' or unquoted)
    return match[1].replace(/^\$?'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
  }

  private async readRemoteVersion(sshHost: string, prefix?: string): Promise<string | undefined> {
    const harnessDir = `~/.azito/harness${prefix ? `-${prefix}` : ''}`;
    const result = await this.sshClient.execIsolated(sshHost, `cat ${harnessDir}/VERSION 2>/dev/null`);
    const version = result.stdout.trim();
    return version || undefined;
  }
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
