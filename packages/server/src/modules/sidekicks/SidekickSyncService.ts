import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { IServerTransport } from '../servers/transport/ServerTransport';
import { isShellFileOps } from '../servers/transport/ShellFileOps';
import type { ServerConfig } from '../servers/Server';
import type { SidekickPackage } from './SidekickPackage';
import { syncThroughFileOps } from './fileOpsSidekickSync';
import { syncThroughShell } from './shellSidekickSync';
import { REMOTE_SIDEKICKS_BASE, type SidekickSyncContext } from './sidekickSyncShared';
import { collectTreeEntries, packTarGz } from '../../shared/fs/tarGz';

export { REMOTE_SIDEKICKS_BASE } from './sidekickSyncShared';
export { PAYLOAD_CHUNK_SIZE } from './shellSidekickSync';

export interface SidekickSyncOptions {
  /** Remote lock acquisition attempts before giving up (default 3). */
  lockRetries?: number;
  /** Delay between lock attempts in ms (default 2000). */
  lockRetryDelayMs?: number;
}

/**
 * Deterministic content hash of a merged (already layer-resolved) Sidekick
 * package list: sha256 over the sorted list of "<pkgName>/<relPath>:<sha256
 * of file content>" lines. Sorting both the package list and the collected
 * file lines makes the result independent of `fs.readdir` enumeration order
 * and of the order `packages` is passed in.
 */
export function computeSidekicksHash(packages: Pick<SidekickPackage, 'name' | 'dir'>[]): string {
  const lines: string[] = [];
  for (const pkg of packages) {
    collectFileHashLines(pkg.dir, pkg.name, lines);
  }
  lines.sort();
  const hash = crypto.createHash('sha256');
  for (const line of lines) hash.update(line + '\n');
  return hash.digest('hex');
}

function collectFileHashLines(dir: string, relPrefix: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = `${relPrefix}/${entry.name}`;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFileHashLines(abs, rel, out);
    } else if (entry.isFile()) {
      const content = fs.readFileSync(abs);
      const fileHash = crypto.createHash('sha256').update(content).digest('hex');
      out.push(`${rel}:${fileHash}`);
    }
    // Symlinks are intentionally skipped, matching SidekickPackageLoader's
    // layer-traversal-safety policy (no following links out of the package dir).
  }
}

/** `pkg.dir` for local execution; the synced flat path for ssh/agent execution. */
export function resolveSidekickDir(
  pkg: Pick<SidekickPackage, 'name' | 'dir'>,
  server: Pick<ServerConfig, 'type'>,
): string {
  return server.type === 'local' ? pkg.dir : `${REMOTE_SIDEKICKS_BASE}/${pkg.name}`;
}

/**
 * Syncs the full merged Sidekick package tree to a remote server's
 * `~/.azito/sidekicks/` so `{{sidekick.dir}}/scripts/*` is runnable from the
 * tmux pane the task executes in (Issue #263 Phase 6). Diffing follows the
 * AgentUpdater pattern: compare a content hash against a remote marker file
 * and skip the transfer when unchanged.
 *
 * Two routes, fixed by what is recorded of the host (like `transport.files()`):
 * - file operations + `run` (`syncThroughFileOps`): the tarball is written as a
 *   file and `tar` is run without a shell. Any host OS;
 * - shell commands (`syncThroughShell`): an agent registered before its OS was
 *   recorded, which has neither `/api/fileops` nor `/api/run`.
 * A failing route is never retried through the other.
 *
 * Both stage the extraction next to the live tree and swap it in last, so a
 * failed transfer never destroys a previously good tree, take a remote lock
 * against other hub processes, and hub-side in-flight deduplication
 * (Map<serverName, Promise>) makes concurrent tasks targeting the same server
 * share one sync instead of racing each other.
 *
 * Fail-fast: an extraction error / unacquirable lock throws — the caller
 * (PhaseLoopRunner / RenderSkillPromptUseCase) must not swallow this into a
 * silent skip, since a missing/incomplete sidekick.dir on the remote would
 * otherwise fail confusingly deep inside the agent's own shell.
 */
export class SidekickSyncService {
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly lockRetries: number;
  private readonly lockRetryDelayMs: number;

  constructor(options: SidekickSyncOptions = {}) {
    this.lockRetries = options.lockRetries ?? 3;
    this.lockRetryDelayMs = options.lockRetryDelayMs ?? 2000;
  }

  sync(serverName: string, transport: IServerTransport, packages: SidekickPackage[]): Promise<void> {
    const existing = this.inflight.get(serverName);
    if (existing) return existing;
    const run = this.doSync(serverName, transport, packages)
      .finally(() => this.inflight.delete(serverName));
    this.inflight.set(serverName, run);
    return run;
  }

  private doSync(serverName: string, transport: IServerTransport, packages: SidekickPackage[]): Promise<void> {
    const context: SidekickSyncContext = {
      serverName,
      transport,
      hash: computeSidekicksHash(packages),
      buildTarball: async () => buildTarball(packages),
      lockRetries: this.lockRetries,
      lockRetryDelayMs: this.lockRetryDelayMs,
    };
    return isShellFileOps(transport.files()) ? syncThroughShell(context) : syncThroughFileOps(context);
  }
}

/**
 * The gzip-compressed tar of the packages, laid out flat (`<name>/...`). Packed in Node so that the scripts' executable
 * bits (everything under a `scripts/` folder) do not depend on the hub's file system: a Windows hub reports none for
 * `tar` to keep, and the packages are unpacked on a Linux / macOS host.
 */
export function buildTarball(packages: Pick<SidekickPackage, 'name' | 'dir'>[]): Buffer {
  const entries = packages.flatMap((pkg) =>
    collectTreeEntries(pkg.dir, {
      prefix: pkg.name,
      fileMode: (relPath) => (relPath.split('/').slice(0, -1).includes('scripts') ? 0o755 : 0o644),
      directoryMode: 0o755,
    }),
  );
  return packTarGz(entries, Math.floor(Date.now() / 1000));
}
