import * as crypto from 'crypto';
import type { ExecResult, IServerTransport } from '../servers/transport/ServerTransport';
import { HASH_FILENAME, LOCK_STALE_SECONDS, REMOTE_SIDEKICKS_BASE, type SidekickSyncContext } from './sidekickSyncShared';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The sync for an agent registered before its OS was recorded (a Unix one without `/api/fileops` and `/api/run`): shell commands
 * through `exec`, as it always was. `SidekickSyncService` chooses this route once, from what is recorded of the host
 * (see `ShellFileOps`); the agent update that records the host moves the server to `syncThroughFileOps`.
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
 * - Extraction is staged in `~/.azito/sidekicks.tmp.<nonce>` (tar + chmod + hash file
 *   all land there first) and only swapped into place at the very end
 *   (`rm -rf base && mv tmp base`), so a failed transfer never destroys a
 *   previously good tree; the non-atomic window is just that final pair.
 * - Concurrency: a remote `mkdir`-based lock (atomic on POSIX) with a
 *   timestamp file for stale takeover after LOCK_STALE_SECONDS.
 */
export async function syncThroughShell(ctx: SidekickSyncContext): Promise<void> {
  const { transport, hash } = ctx;
  if (await readRemoteHash(transport) === hash) return;

  const nonce = crypto.randomBytes(6).toString('hex');
  await acquireLock(ctx, nonce);
  try {
    const base64 = (await ctx.buildTarball()).toString('base64');
    const payloadPath = `~/.azito/sidekicks-payload.${nonce}.b64`;
    const tmpDir = `~/.azito/sidekicks.tmp.${nonce}`;
    try {
      await uploadPayload(ctx, payloadPath, base64, nonce);
      await extractAndSwap(ctx, payloadPath, tmpDir, nonce);
    } catch (err) {
      // Best-effort cleanup of staging artifacts; the live tree (if any)
      // is untouched because the swap is the last step of extractAndSwap.
      await transport.exec(`rm -rf ${tmpDir} ${payloadPath}`).catch(() => {});
      throw err;
    }
  } finally {
    await transport.exec(`rm -rf ${REMOTE_LOCK_DIR}`).catch(() => {});
  }
}

async function readRemoteHash(transport: IServerTransport): Promise<string | null> {
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
async function acquireLock(ctx: SidekickSyncContext, nonce: string): Promise<void> {
  const marker = `AZITO_LOCK_OK_${nonce}`;
  const cmd = [
    `if mkdir ${REMOTE_LOCK_DIR} 2>/dev/null; then date +%s > ${REMOTE_LOCK_DIR}/ts; echo ${marker};`,
    `else ts=$(cat ${REMOTE_LOCK_DIR}/ts 2>/dev/null || echo 0); now=$(date +%s);`,
    `if [ $((now - ts)) -gt ${LOCK_STALE_SECONDS} ]; then rm -rf ${REMOTE_LOCK_DIR};`,
    `mkdir ${REMOTE_LOCK_DIR} 2>/dev/null && date +%s > ${REMOTE_LOCK_DIR}/ts && echo ${marker}; fi; fi`,
  ].join(' ');

  for (let attempt = 0; attempt < ctx.lockRetries; attempt++) {
    const result = await ctx.transport.exec(cmd);
    if (result.code === 0 && result.stdout.includes(marker)) return;
    if (attempt < ctx.lockRetries - 1) await sleep(ctx.lockRetryDelayMs);
  }
  throw new Error(
    `Sidekick sync to server "${ctx.serverName}" failed: could not acquire remote lock ${REMOTE_LOCK_DIR} after ${ctx.lockRetries} attempts (another sync in progress?)`,
  );
}

async function uploadPayload(ctx: SidekickSyncContext, payloadPath: string, base64: string, nonce: string): Promise<void> {
  const marker = `AZITO_CHUNK_OK_${nonce}`;
  for (let offset = 0; offset < base64.length; offset += PAYLOAD_CHUNK_SIZE) {
    const chunk = base64.slice(offset, offset + PAYLOAD_CHUNK_SIZE);
    // First chunk truncates (fresh file even after a crashed prior attempt),
    // the rest append. The base64 alphabet contains no single quotes, so
    // single-quoting is safe.
    const redirect = offset === 0 ? '>' : '>>';
    const result = await ctx.transport.exec(`printf '%s' '${chunk}' ${redirect} ${payloadPath} && echo ${marker}`);
    assertStepSucceeded(result, marker, ctx.serverName, 'payload upload');
  }
}

async function extractAndSwap(ctx: SidekickSyncContext, payloadPath: string, tmpDir: string, nonce: string): Promise<void> {
  const marker = `AZITO_SYNC_OK_${nonce}`;
  // Everything (extract, chmod, hash file) is staged in tmpDir; the live tree
  // is only replaced at the very end, so any failure up to that point leaves
  // the previous tree intact. The `rm -rf base && mv` pair is the only
  // remaining non-atomic window.
  const command = [
    `mkdir -p ${tmpDir}`,
    `base64 -d < ${payloadPath} | tar xzf - -C ${tmpDir}`,
    `find ${tmpDir} -type d -name scripts -exec chmod -R 755 {} +`,
    `echo '${ctx.hash}' > ${tmpDir}/${HASH_FILENAME}`,
    `rm -f ${payloadPath}`,
    `rm -rf ${REMOTE_SIDEKICKS_BASE}`,
    `mv ${tmpDir} ${REMOTE_SIDEKICKS_BASE}`,
    `echo ${marker}`,
  ].join(' && ');

  const result = await ctx.transport.exec(command);
  assertStepSucceeded(result, marker, ctx.serverName, 'extract/swap');
}

/**
 * SSH transport limitation: its persistent-shell marker protocol always
 * reports `code: 0` / `stderr: ''`, so success must be proven by the
 * per-invocation stdout marker. The exit-code check still catches failures
 * on local/agent transports (which report real codes and stderr).
 */
function assertStepSucceeded(result: ExecResult, marker: string, serverName: string, step: string): void {
  if (result.code !== 0 || !result.stdout.includes(marker)) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(' | ') || `exit ${result.code}`;
    throw new Error(`Sidekick sync to server "${serverName}" failed (${step}): ${detail}`);
  }
}
