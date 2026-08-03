import * as crypto from 'crypto';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { ExecResult, IServerTransport } from '../servers/transport/ServerTransport';
import type { ServerConfig } from '../servers/Server';
import type { SidekickPackage } from './SidekickPackage';

const execFileAsync = promisify(execFile);

// Remote placement mirrors the existing `~/.azito/<thing>` convention used by
// HarnessInstaller (`~/.azito/harness`) and AgentInstaller (`~/.azito/agent`).
// Packages land flat under this base (`<base>/<name>/`) — the builtin/user
// layer split is a hub-local concept only; the merge already happened before
// this service ever sees the package list.
export const REMOTE_SIDEKICKS_BASE = '~/.azito/sidekicks';
const HASH_FILENAME = '.azito-sidekicks-hash';
const REMOTE_HASH_FILE = `${REMOTE_SIDEKICKS_BASE}/${HASH_FILENAME}`;
const REMOTE_LOCK_DIR = '~/.azito/sidekicks.lock';

/**
 * Base64 payload chunk size per `exec` round-trip. 48KB keeps each command
 * string comfortably below conservative per-argument limits (~128KB single
 * MAX_ARG_STRLEN on Linux is 128KB; the agent path runs the command through
 * `execFile('/bin/sh', ['-c', cmd])` so the whole command is one argv entry),
 * below the agent's default 15s per-exec timeout for a single write, and
 * keeps the SSH persistent-shell single-line writes modest.
 */
export const PAYLOAD_CHUNK_SIZE = 48 * 1024;

/** A lock older than this is considered abandoned (crashed holder) and is taken over. */
const LOCK_STALE_SECONDS = 300;

export interface SidekickSyncOptions {
  /** Remote lock acquisition attempts before giving up (default 3). */
  lockRetries?: number;
  /** Delay between lock attempts in ms (default 2000). */
  lockRetryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * Robustness (independent review findings):
 * - Success is detected via a per-invocation output marker (e.g.
 *   `AZITO_SYNC_OK_<nonce>` in stdout) IN ADDITION to the exit code — the SSH
 *   transport's persistent-shell protocol always reports code 0 / empty
 *   stderr, so exit codes alone are not trustworthy there (they still work
 *   for local/agent transports).
 * - The payload is uploaded in PAYLOAD_CHUNK_SIZE base64 chunks (several
 *   small execs) instead of one giant command, avoiding ARG_MAX limits and
 *   the agent's per-exec timeout.
 * - Extraction is staged in `~/.azito/sidekicks.tmp.<nonce>` (tar + chmod +
 *   hash file all land there first) and only swapped into place at the very
 *   end (`rm -rf base && mv tmp base`), so a failed transfer never destroys a
 *   previously good tree; the non-atomic window is just that final pair.
 * - Concurrency: a remote `mkdir`-based lock (atomic on POSIX) with a
 *   timestamp file for stale takeover after LOCK_STALE_SECONDS guards against
 *   other hub processes, and hub-side in-flight deduplication
 *   (Map<serverName, Promise>) makes concurrent tasks targeting the same
 *   server share one sync instead of racing each other.
 *
 * Fail-fast: a missing marker / non-zero exit / unacquirable lock throws —
 * the caller (PhaseLoopRunner / RenderSkillPromptUseCase) must not swallow
 * this into a silent skip, since a missing/incomplete sidekick.dir on the
 * remote would otherwise fail confusingly deep inside the agent's own shell.
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

  private async doSync(serverName: string, transport: IServerTransport, packages: SidekickPackage[]): Promise<void> {
    const hash = computeSidekicksHash(packages);

    const remoteHash = await this.readRemoteHash(transport);
    if (remoteHash === hash) return;

    const nonce = crypto.randomBytes(6).toString('hex');
    await this.acquireLock(serverName, transport, nonce);
    try {
      const base64 = await this.buildTarballBase64(packages);
      const payloadPath = `~/.azito/sidekicks-payload.${nonce}.b64`;
      const tmpDir = `~/.azito/sidekicks.tmp.${nonce}`;
      try {
        await this.uploadPayload(serverName, transport, payloadPath, base64, nonce);
        await this.extractAndSwap(serverName, transport, payloadPath, tmpDir, hash, nonce);
      } catch (err) {
        // Best-effort cleanup of staging artifacts; the live tree (if any)
        // is untouched because the swap is the last step of extractAndSwap.
        await transport.exec(`rm -rf ${tmpDir} ${payloadPath}`).catch(() => {});
        throw err;
      }
    } finally {
      await this.releaseLock(transport).catch(() => {});
    }
  }

  // ─── Steps ───

  private async readRemoteHash(transport: IServerTransport): Promise<string | null> {
    const result = await transport.exec(`cat ${REMOTE_HASH_FILE} 2>/dev/null || true`);
    const value = result.stdout.trim();
    return value || null;
  }

  /**
   * `mkdir` is atomic on POSIX filesystems, so it doubles as a lock. A
   * timestamp file inside the lock dir enables stale takeover: if the holder
   * died more than LOCK_STALE_SECONDS ago, the lock is removed and re-acquired
   * within the same remote command.
   */
  private async acquireLock(serverName: string, transport: IServerTransport, nonce: string): Promise<void> {
    const marker = `AZITO_LOCK_OK_${nonce}`;
    const cmd = [
      `if mkdir ${REMOTE_LOCK_DIR} 2>/dev/null; then date +%s > ${REMOTE_LOCK_DIR}/ts; echo ${marker};`,
      `else ts=$(cat ${REMOTE_LOCK_DIR}/ts 2>/dev/null || echo 0); now=$(date +%s);`,
      `if [ $((now - ts)) -gt ${LOCK_STALE_SECONDS} ]; then rm -rf ${REMOTE_LOCK_DIR};`,
      `mkdir ${REMOTE_LOCK_DIR} 2>/dev/null && date +%s > ${REMOTE_LOCK_DIR}/ts && echo ${marker}; fi; fi`,
    ].join(' ');

    for (let attempt = 0; attempt < this.lockRetries; attempt++) {
      const result = await transport.exec(cmd);
      if (result.code === 0 && result.stdout.includes(marker)) return;
      if (attempt < this.lockRetries - 1) await sleep(this.lockRetryDelayMs);
    }
    throw new Error(
      `Sidekick sync to server "${serverName}" failed: could not acquire remote lock ${REMOTE_LOCK_DIR} after ${this.lockRetries} attempts (another sync in progress?)`,
    );
  }

  private releaseLock(transport: IServerTransport): Promise<ExecResult> {
    return transport.exec(`rm -rf ${REMOTE_LOCK_DIR}`);
  }

  private async uploadPayload(
    serverName: string,
    transport: IServerTransport,
    payloadPath: string,
    base64: string,
    nonce: string,
  ): Promise<void> {
    const marker = `AZITO_CHUNK_OK_${nonce}`;
    for (let offset = 0; offset < base64.length; offset += PAYLOAD_CHUNK_SIZE) {
      const chunk = base64.slice(offset, offset + PAYLOAD_CHUNK_SIZE);
      // First chunk truncates (fresh file even after a crashed prior attempt),
      // the rest append. The base64 alphabet contains no single quotes, so
      // single-quoting is safe.
      const redirect = offset === 0 ? '>' : '>>';
      const result = await transport.exec(`printf '%s' '${chunk}' ${redirect} ${payloadPath} && echo ${marker}`);
      this.assertStepSucceeded(result, marker, serverName, 'payload upload');
    }
  }

  private async extractAndSwap(
    serverName: string,
    transport: IServerTransport,
    payloadPath: string,
    tmpDir: string,
    hash: string,
    nonce: string,
  ): Promise<void> {
    const marker = `AZITO_SYNC_OK_${nonce}`;
    // Everything (extract, chmod, hash file) is staged in tmpDir; the live
    // tree is only replaced at the very end, so any failure up to that point
    // leaves the previous tree intact. The `rm -rf base && mv` pair is the
    // only remaining non-atomic window.
    const command = [
      `mkdir -p ${tmpDir}`,
      `base64 -d < ${payloadPath} | tar xzf - -C ${tmpDir}`,
      `find ${tmpDir} -type d -name scripts -exec chmod -R 755 {} +`,
      `echo '${hash}' > ${tmpDir}/${HASH_FILENAME}`,
      `rm -f ${payloadPath}`,
      `rm -rf ${REMOTE_SIDEKICKS_BASE}`,
      `mv ${tmpDir} ${REMOTE_SIDEKICKS_BASE}`,
      `echo ${marker}`,
    ].join(' && ');

    const result = await transport.exec(command);
    this.assertStepSucceeded(result, marker, serverName, 'extract/swap');
  }

  /**
   * SSH transport limitation: its persistent-shell marker protocol always
   * reports `code: 0` / `stderr: ''`, so success must be proven by the
   * per-invocation stdout marker. The exit-code check still catches failures
   * on local/agent transports (which report real codes and stderr).
   */
  private assertStepSucceeded(result: ExecResult, marker: string, serverName: string, step: string): void {
    if (result.code !== 0 || !result.stdout.includes(marker)) {
      const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(' | ') || `exit ${result.code}`;
      throw new Error(`Sidekick sync to server "${serverName}" failed (${step}): ${detail}`);
    }
  }

  private async buildTarballBase64(packages: SidekickPackage[]): Promise<string> {
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-sidekicks-stage-'));
    const tarPath = path.join(os.tmpdir(), `azito-sidekicks-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tar.gz`);
    try {
      for (const pkg of packages) {
        fs.cpSync(pkg.dir, path.join(stageDir, pkg.name), { recursive: true, dereference: false });
      }
      await execFileAsync('tar', ['czf', tarPath, '-C', stageDir, '.']);
      return fs.readFileSync(tarPath).toString('base64');
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true });
      fs.rmSync(tarPath, { force: true });
    }
  }
}
