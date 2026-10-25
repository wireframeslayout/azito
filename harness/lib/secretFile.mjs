// Secret files (webhook token, UI token) readable by the owner only: mode 600 on POSIX, a protected DACL on Windows.
// Same policy as the hub's SecretFileGuard (packages/server/src/shared/os/secretFileGuard.ts): the file is created protected
// in the directory it ends up in, then written, then renamed over the target, so the content is never readable by anyone else.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CREATE_SCRIPT, PROTECT_SCRIPT } from './winAclScripts.mjs';

const RENAME_RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 6;
const RENAME_RETRY_DELAY_MS = 50;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`. No SystemRoot is an error: PATH is not searched. */
export function resolvePowerShellPath(env) {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  if (!systemRoot) throw new Error('Cannot locate powershell.exe: the SystemRoot environment variable is not set');
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function powerShellRunner(env) {
  const powershellPath = resolvePowerShellPath(env);
  return (script, targetPath) => {
    const childEnv = { ...env, AZITO_GUARD_PATH: targetPath };
    // A PowerShell 7 parent leaves a PSModulePath that does not fit 5.1.
    for (const key of Object.keys(childEnv)) if (key.toLowerCase() === 'psmodulepath') delete childEnv[key];
    try {
      return execFileSync(powershellPath, ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const stderr = err.stderr?.trim();
      throw new Error(`Failed to restrict access to ${targetPath} (${powershellPath}): ${stderr || err.message}`);
    }
  };
}

function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= RENAME_ATTEMPTS || !RENAME_RETRYABLE.has(err.code)) throw err;
      sleepSync(RENAME_RETRY_DELAY_MS);
    }
  }
}

/** `platform` and `env` come from the entry point (setup.mjs reads process.platform / process.env once). */
export function createSecretFiles({ platform, env }) {
  const windows = platform === 'win32';
  const runPowerShell = windows ? powerShellRunner(env) : null;

  /** Creates the directory (and its parents). On Windows a directory made now is protected; an existing one is not touched. */
  function ensureDir(dir) {
    const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (windows && created !== undefined) runPowerShell(PROTECT_SCRIPT, dir);
  }

  /** Replaces `filePath` with `content`, readable by the owner only from the moment it exists. */
  function writeSecretFile(filePath, content) {
    const dir = path.dirname(filePath);
    ensureDir(dir);
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      if (windows) {
        runPowerShell(CREATE_SCRIPT, tmp);
        fs.writeFileSync(tmp, content);
      } else {
        fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
      }
      renameWithRetry(tmp, filePath);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }

  return { ensureDir, writeSecretFile };
}
