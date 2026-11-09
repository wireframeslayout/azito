import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LookoutSettings } from './SqliteLookoutSettingsRepository';
import { buildAllowedEnv } from '../llm/execEnv';

const PLATFORM_ENV_KEYS = ['USERPROFILE', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP'] as const;
const CLAUDE_ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;
const CODEX_ENV_KEYS = ['CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_CA_CERTIFICATE'] as const;

async function run(binary: string, args: string[], cwd: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = binary === 'claude'
      ? buildAllowedEnv([...PLATFORM_ENV_KEYS, ...CLAUDE_ENV_KEYS], CODEX_ENV_KEYS)
      : buildAllowedEnv(PLATFORM_ENV_KEYS);
    const proc = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '';
    let failed = false;
    const terminate = () => {
      failed = true;
      if (process.platform !== 'win32' && proc.pid) {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
      } else proc.kill('SIGKILL');
    };
    const timer = setTimeout(terminate, 120_000);
    proc.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > 1_000_000) { terminate(); return; }
      stdout += chunk.toString();
    });
    proc.stderr.resume();
    proc.stdin.on('error', () => {});
    proc.stdin.end(input);
    proc.on('error', () => { clearTimeout(timer); reject(new Error('cli_unavailable')); });
    proc.on('close', (code) => { clearTimeout(timer); code === 0 && !failed ? resolve(stdout) : reject(new Error('cli_failed')); });
  });
}

export async function runLookoutLlm(settings: LookoutSettings, prompt: string): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), 'azito-lookout-'));
  try {
    if (settings.provider === 'claude') {
      const output = await run('claude', ['-p', '--output-format', 'json', '--model', settings.model, '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence'], cwd, prompt);
      const parsed: unknown = JSON.parse(output);
      if (typeof parsed !== 'object' || parsed === null || !('result' in parsed) || typeof parsed.result !== 'string' || !('is_error' in parsed) || parsed.is_error !== false) throw new Error('cli_failed');
      return parsed.result;
    }
    const outputFile = join(cwd, 'output');
    await run('codex', ['exec', '--sandbox', 'read-only', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'sleep_tool', '-c', 'web_search=\"disabled\"', '-m', settings.model, '-o', outputFile, '-'], cwd, prompt);
    if (statSync(outputFile).size > 1_000_000) throw new Error('cli_failed');
    return readFileSync(outputFile, 'utf8');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

export async function probeLookoutLlm(settings: LookoutSettings): Promise<{ ok: boolean; version: string | null; reason: string | null; remedy: string | null }> {
  const cwd = mkdtempSync(join(tmpdir(), 'azito-lookout-probe-'));
  let version: string | null = null;
  let stage: 'version' | 'login' | 'summary' = 'version';
  try {
    version = (await run(settings.provider, ['--version'], cwd, '')).replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim().slice(0, 100);
    if (!version) throw new Error('empty_version');
    stage = 'login';
    const auth = await run(settings.provider, settings.provider === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'], cwd, '');
    if (settings.provider === 'claude') {
      const parsed: unknown = JSON.parse(auth);
      if (typeof parsed !== 'object' || parsed === null || !('loggedIn' in parsed) || parsed.loggedIn !== true) throw new Error('not_logged_in');
    }
    stage = 'summary';
    const output = await runLookoutLlm(settings, 'Reply with OK on one line.');
    if (!output.trim()) throw new Error('empty_summary');
    return { ok: true, version, reason: null, remedy: null };
  } catch {
    const remedy = stage === 'version' ? 'Check CLI installation.' : stage === 'login' ? 'Check CLI login status.' : 'Check model access and CLI configuration.';
    return { ok: false, version, reason: `${stage}_failed`, remedy };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
