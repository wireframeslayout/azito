import { spawn } from 'child_process';
import { win32 as winPath } from 'path';
import { buildAllowedEnv } from './execEnv';
import { findWindowsHeadlessCommand, windowsShimCommand, UnsafeShimArgumentError, type CliSearchDetails } from './windowsHeadlessCommand';

export type CliFailureReason = 'cli_not_found' | 'not_logged_in' | 'timeout' | 'failed';
export class HeadlessCliError extends Error {
  constructor(readonly reason: CliFailureReason, readonly search?: CliSearchDetails, readonly detail?: 'unsafe_argument') { super(reason); }
}
export function classifyCliFailure(text: string): CliFailureReason {
  return /(?:not logged in|not authenticated|please (?:log|sign) in|authentication required|invalid api key|unauthorized|http 401)/i.test(text) ? 'not_logged_in' : 'failed';
}

const PLATFORM_ENV_KEYS = ['USERPROFILE', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'PATHEXT'] as const;
const CLAUDE_ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;
const CODEX_ENV_KEYS = ['CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_CA_CERTIFICATE'] as const;

export async function runHeadlessCommand(binary: string, args: string[], cwd: string, input: string, timeoutMs = 120_000): Promise<string> {
  const env = binary === 'claude'
      ? buildAllowedEnv([...PLATFORM_ENV_KEYS, ...CLAUDE_ENV_KEYS], CODEX_ENV_KEYS)
      : buildAllowedEnv(PLATFORM_ENV_KEYS);
  let command = binary;
  let commandArgs = args;
  let verbatim = false;
  if (process.platform === 'win32') {
    const result = await findWindowsHeadlessCommand(binary, env);
    if (!result.file) throw new HeadlessCliError('cli_not_found', result.search);
    command = result.file;
    if (/\.(cmd|bat)$/i.test(command)) {
      try { const shim = windowsShimCommand(command, args, env); command = shim.command; commandArgs = shim.args; verbatim = true; }
      catch (error) { throw new HeadlessCliError('failed', undefined, error instanceof UnsafeShimArgumentError ? 'unsafe_argument' : undefined); }
    }
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(command, commandArgs, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsVerbatimArguments: verbatim });
    let stdout = '';
    let stderr = '';
    let reason: CliFailureReason | null = null;
    // Ends the process tree once; later overflow chunks or the timer must not start another taskkill.
    const terminate = (cause: CliFailureReason) => {
      if (reason) return;
      reason = cause;
      if (process.platform !== 'win32' && proc.pid) {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
      } else if (proc.pid && env.SystemRoot) {
        const killer = spawn(winPath.join(env.SystemRoot, 'System32', 'taskkill.exe'), ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore' });
        killer.on('error', () => proc.kill('SIGKILL'));
        killer.on('close', code => { if (code !== 0) proc.kill('SIGKILL'); });
      } else proc.kill('SIGKILL');
    };
    const timer = setTimeout(() => terminate('timeout'), timeoutMs);
    proc.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > 1_000_000) { terminate('failed'); return; }
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 16_384) stderr += chunk.toString().slice(0, 16_384 - stderr.length); });
    proc.stdin.on('error', () => {});
    proc.stdin.end(input);
    proc.on('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); reject(new HeadlessCliError(error.code === 'ENOENT' ? 'cli_not_found' : 'failed')); });
    proc.on('close', (code) => { clearTimeout(timer); code === 0 && !reason ? resolve(stdout) : reject(new HeadlessCliError(reason ?? classifyCliFailure(`${stderr} ${stdout.slice(0, 16_384)}`))); });
  });
}
