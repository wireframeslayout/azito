import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeLookoutLlm, runLookoutLlm } from './LlmClientFactory';

const originalPath = process.env.PATH;
const originalSecret = process.env.AZITO_UI_TOKEN;
const originalAnthropicToken = process.env.ANTHROPIC_AUTH_TOKEN;
let dir: string | undefined;
afterEach(() => {
  process.env.PATH = originalPath;
  if (originalSecret === undefined) delete process.env.AZITO_UI_TOKEN; else process.env.AZITO_UI_TOKEN = originalSecret;
  if (originalAnthropicToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicToken;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('Lookout CLI', () => {
  it('passes the prompt on stdin with a restricted environment and isolated cwd', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lookout-test-'));
    const executable = join(dir, 'claude');
    const capture = join(dir, 'capture');
    writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' "$PWD" "$AZITO_UI_TOKEN" "$ANTHROPIC_AUTH_TOKEN" "$*" > '${capture}'\ncat >> '${capture}'\nprintf '{"is_error":false,"result":"done"}'\n`);
    chmodSync(executable, 0o755);
    process.env.PATH = `${dir}:${originalPath}`;
    process.env.AZITO_UI_TOKEN = 'must-not-leak';
    process.env.ANTHROPIC_AUTH_TOKEN = 'auth-token';
    expect(await runLookoutLlm({ enabled: true, provider: 'claude', model: 'sonnet', updatedAt: '' }, 'private prompt')).toBe('done');
    const captured = readFileSync(capture, 'utf8');
    expect(captured).toContain('--tools  --setting-sources  --strict-mcp-config --no-session-persistence --disable-slash-commands');
    expect(captured).toContain('private prompt');
    expect(captured).not.toContain('must-not-leak');
    expect(captured).toContain('auth-token');
    expect(captured.split('\n')[0]).not.toBe(process.cwd());
  });
  it('uses Codex isolation options and reads its output file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lookout-test-'));
    const executable = join(dir, 'codex');
    const capture = join(dir, 'args');
    writeFileSync(executable, `#!/bin/sh
printf '%s\n' "$@" > '${capture}'
while [ "$#" -gt 0 ]; do if [ "$1" = '-o' ]; then shift; printf 'done' > "$1"; fi; shift; done
`);
    chmodSync(executable, 0o755);
    process.env.PATH = `${dir}:${originalPath}`;
    expect(await runLookoutLlm({ enabled: true, provider: 'codex', model: 'test-model', updatedAt: '' }, 'private prompt')).toBe('done');
    const args = readFileSync(capture, 'utf8');
    expect(args).toContain('shell_tool');
    expect(args).toContain('web_search="disabled"');
    expect(args).toContain('test-model');
    expect(args).not.toContain('private prompt');
  });
  it('rejects error JSON without exposing its contents', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lookout-test-'));
    const executable = join(dir, 'claude');
    writeFileSync(executable, `#!/bin/sh
printf '{"is_error":true,"result":"private error"}'
`);
    chmodSync(executable, 0o755);
    process.env.PATH = `${dir}:${originalPath}`;
    await expect(runLookoutLlm({ enabled: true, provider: 'claude', model: 'sonnet', updatedAt: '' }, 'private prompt')).rejects.toThrow('failed');
  });

  it('reports version and failed authentication in the probe contract', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lookout-test-'));
    const executable = join(dir, 'claude');
    writeFileSync(executable, `#!/bin/sh
if [ "$1" = '--version' ]; then echo 'claude 1.0'; else echo '{"loggedIn":false}'; fi
`);
    chmodSync(executable, 0o755);
    process.env.PATH = `${dir}:${originalPath}`;
    expect(await probeLookoutLlm({ enabled: true, provider: 'claude', model: 'sonnet', updatedAt: '' })).toEqual({ ok: false, cli: { found: true, version: 'claude 1.0' }, reason: 'not_logged_in', hint: 'Check CLI login status.' });
  });

});
