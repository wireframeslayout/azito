import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runHeadlessCommand } from './headlessExec';

export async function runCodexLookout(model: string, prompt: string): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), 'azito-lookout-'));
  try {
    const output = join(cwd, 'output');
    await runHeadlessCommand('codex', ['exec', '--sandbox', 'read-only', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'sleep_tool', '-c', "web_search='disabled'", '-m', model, '-o', output, '-'], cwd, prompt);
    if (statSync(output).size > 1_000_000) throw new Error('cli_failed');
    return readFileSync(output, 'utf8');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
