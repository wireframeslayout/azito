import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LookoutSettings } from './SqliteLookoutSettingsRepository';
import { HeadlessCliError, runHeadlessCommand, type CliFailureReason } from '../llm/headlessExec';
import { ClaudeExecClient } from '../llm/ClaudeExecClient';


export async function runLookoutLlm(settings: LookoutSettings, prompt: string): Promise<string> {
  if (settings.provider === 'claude') return new ClaudeExecClient(settings.model).exec(prompt);
  const cwd = mkdtempSync(join(tmpdir(), 'azito-lookout-'));
  try {
    const outputFile = join(cwd, 'output');
    await runHeadlessCommand('codex', ['exec', '--sandbox', 'read-only', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'sleep_tool', '-c', 'web_search=\"disabled\"', '-m', settings.model, '-o', outputFile, '-'], cwd, prompt);
    if (statSync(outputFile).size > 1_000_000) throw new Error('cli_failed');
    return readFileSync(outputFile, 'utf8');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

export async function probeLookoutLlm(settings: LookoutSettings): Promise<{ ok: boolean; cli: { found: boolean; version: string | null }; reason?: CliFailureReason; hint?: string }> {
  const cwd = mkdtempSync(join(tmpdir(), 'azito-lookout-probe-'));
  let version: string | null = null;
  let stage: 'version' | 'login' | 'summary' = 'version';
  try {
    version = (await runHeadlessCommand(settings.provider, ['--version'], cwd, '')).replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim().slice(0, 100);
    if (!version) throw new Error('empty_version');
    stage = 'login';
    const auth = await runHeadlessCommand(settings.provider, settings.provider === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'], cwd, '');
    if (settings.provider === 'claude') {
      const parsed: unknown = JSON.parse(auth);
      if (typeof parsed !== 'object' || parsed === null || !('loggedIn' in parsed) || parsed.loggedIn !== true) throw new HeadlessCliError('not_logged_in');
    }
    stage = 'summary';
    const output = await runLookoutLlm(settings, 'Reply with OK on one line.');
    if (!output.trim()) throw new Error('empty_summary');
    return { ok: true, cli: { found: true, version } };
  } catch (error) {
    const reason = error instanceof HeadlessCliError ? error.reason : 'failed';
    const hint = stage === 'version' ? 'Check CLI installation.' : stage === 'login' ? 'Check CLI login status.' : 'Check model access and CLI configuration.';
    return { ok: false, cli: { found: reason !== 'cli_not_found', version }, reason, hint };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
