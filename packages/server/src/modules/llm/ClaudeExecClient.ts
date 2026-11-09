import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ILlmClient } from './ILlmClient';
import { classifyCliFailure, HeadlessCliError, runHeadlessCommand } from './headlessExec';

export class ClaudeExecClient implements ILlmClient {
  constructor(private readonly model: string) {}

  async exec(prompt: string): Promise<string> {
    const cwd = mkdtempSync(join(tmpdir(), 'azito-lookout-'));
    try {
      const output = await runHeadlessCommand('claude', ['-p', '--output-format', 'json', '--model', this.model, '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands'], cwd, prompt);
      let parsed: unknown;
      try { parsed = JSON.parse(output); } catch { throw new HeadlessCliError('failed'); }
      if (typeof parsed !== 'object' || parsed === null || !('result' in parsed) || typeof parsed.result !== 'string' || !('is_error' in parsed)) throw new HeadlessCliError('failed');
      if (parsed.is_error !== false) throw new HeadlessCliError(classifyCliFailure(parsed.result));
      return parsed.result;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}
