import { spawn } from 'child_process';
import { buildAllowedEnv } from './execEnv';

export type CliFailureReason = 'not_installed' | 'not_authenticated' | 'timeout' | 'failed';
export class HeadlessCliError extends Error {
  constructor(readonly reason: CliFailureReason) { super(reason); }
}
export function classifyCliFailure(text: string): CliFailureReason {
  return /(?:not logged in|not authenticated|please (?:log|sign) in|authentication required|invalid api key|unauthorized|http 401)/i.test(text) ? 'not_authenticated' : 'failed';
}

const PLATFORM_ENV_KEYS = ['USERPROFILE', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP'] as const;
const CLAUDE_ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;
const CODEX_ENV_KEYS = ['CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_CA_CERTIFICATE'] as const;

export async function runHeadlessCommand(binary: string, args: string[], cwd: string, input: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = binary === 'claude'
      ? buildAllowedEnv([...PLATFORM_ENV_KEYS, ...CLAUDE_ENV_KEYS], CODEX_ENV_KEYS)
      : buildAllowedEnv(PLATFORM_ENV_KEYS);
    const proc = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let reason: CliFailureReason | null = null;
    const terminate = () => {
      reason = reason ?? 'failed';
      if (process.platform !== 'win32' && proc.pid) {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
      } else proc.kill('SIGKILL');
    };
    const timer = setTimeout(() => { reason = 'timeout'; terminate(); }, timeoutMs);
    proc.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > 1_000_000) { terminate(); return; }
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 16_384) stderr += chunk.toString().slice(0, 16_384 - stderr.length); });
    proc.stdin.on('error', () => {});
    proc.stdin.end(input);
    proc.on('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); reject(new HeadlessCliError(error.code === 'ENOENT' ? 'not_installed' : 'failed')); });
    proc.on('close', (code) => { clearTimeout(timer); code === 0 && !reason ? resolve(stdout) : reject(new HeadlessCliError(reason ?? classifyCliFailure(`${stderr} ${stdout.slice(0, 16_384)}`))); });
  });
}
