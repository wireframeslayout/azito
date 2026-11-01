import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessMcpScript, parseHarnessMcpOutput } from './windowsHarnessMcpUninstall';

describe('Claude harness MCP removal', () => {
  it('extracts the framed result and reports malformed output without exposing it', () => {
    expect(parseHarnessMcpOutput('warning with secret\r\nAZITO_MCP_RESULT:{"outcome":"done"}\r\n')).toEqual({ outcome: 'done' });
    for (const [output, reason] of [
      ['secret', 'expected one result marker'],
      ['AZITO_MCP_RESULT:secret', 'result is not JSON'],
      ['AZITO_MCP_RESULT:{"token":"secret"}', 'missing or invalid outcome'],
      ['AZITO_MCP_RESULT:{"outcome":"done"}\nAZITO_MCP_RESULT:{"outcome":"done"}', 'expected one result marker'],
    ]) {
      try { parseHarnessMcpOutput(output!); throw new Error('accepted invalid output'); }
      catch (error) {
        expect((error as Error).message).toContain(reason);
        expect((error as Error).message).not.toContain('secret');
      }
    }
  });
  it('passes the compressed script and arguments through the Node launcher', () => {
    const home = mkdtempSync(join(tmpdir(), 'azito mcp-'));
    try {
      const settings = join(home, '.claude', 'settings.json');
      const target = join(home, 'index.js');
      mkdirSync(join(home, '.claude'));
      writeFileSync(target, '');
      writeFileSync(settings, JSON.stringify({ mcpServers: { 'azt-mcp': { command: 'node', args: [target] } } }));
      const script = harnessMcpScript('claude', process.execPath, home, target);
      const payload = /AZITO_MCP_SRC = '([^']+)'/.exec(script)![1];
      const launcher = / -e '([^']+)'/.exec(script)![1];
      expect(launcher).not.toMatch(/["'\\]/);
      const output = execFileSync(process.execPath, ['-e', launcher], { encoding: 'utf8', env: { ...process.env, AZITO_MCP_SRC: payload } });
      expect(parseHarnessMcpOutput(output).outcome).toBe('done');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('removes only a matching entry and is safe to repeat', () => {
    const home = mkdtempSync(join(tmpdir(), 'azito-mcp-'));
    try {
      const settings = join(home, '.claude', 'settings.json');
      const target = join(home, 'index.js');
      mkdirSync(join(home, '.claude'));
      writeFileSync(target, '');
      writeFileSync(settings, JSON.stringify({ other: true, mcpServers: { 'azt-mcp': { command: 'node', args: [target], env: { TOKEN: 'secret' } }, other: { command: 'other' } } }));
      const script = harnessMcpScript('claude', process.execPath, home, target);
      const encoded = /AZITO_MCP_SRC = '([^']+)'/.exec(script)?.[1];
      expect(encoded).toBeDefined();
      const source = JSON.parse(gunzipSync(Buffer.from(encoded!, 'base64')).toString('utf8')).source;
      const run = () => parseHarnessMcpOutput(execFileSync(process.execPath, ['-e', source, 'claude', home, target], { encoding: 'utf8' }));
      expect(run().outcome).toBe('done');
      expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ other: true, mcpServers: { other: { command: 'other' } } });
      expect(run().outcome).toBe('absent');
      writeFileSync(settings, JSON.stringify({ mcpServers: { 'azt-mcp': { command: 'other', args: [target] } } }));
      expect(run().outcome).toBe('skipped');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform === 'win32')('removes a matching Codex registration through the CLI and leaves a different registration alone', () => {
    const home = mkdtempSync(join(tmpdir(), 'azito-codex-'));
    try {
      const target = join(home, 'index.js');
      const response = join(home, 'response.json');
      const marker = join(home, 'removed');
      const executable = join(home, 'codex.EXE');
      writeFileSync(target, '');
      writeFileSync(executable, `#!/bin/sh\nif [ "$2" = get ]; then /bin/cat "${response}"; else /usr/bin/touch "${marker}"; fi\n`);
      chmodSync(executable, 0o755);
      const script = harnessMcpScript('codex', process.execPath, home, target);
      const encoded = /AZITO_MCP_SRC = '([^']+)'/.exec(script)![1];
      const source = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8')).source;
      const run = () => parseHarnessMcpOutput(execFileSync(process.execPath, ['-e', source, 'codex', home, target], { encoding: 'utf8', env: { ...process.env, PATH: home, PATHEXT: '.EXE', CODEX_HOME: join(home, 'custom') } }));
      // The host script uses Windows PATH separators.
      writeFileSync(response, JSON.stringify({ transport: { command: 'node', args: [target] } }));
      expect(run().outcome).toBe('done');
      expect(readFileSync(marker, 'utf8')).toBe('');
      rmSync(marker);
      writeFileSync(response, JSON.stringify({ transport: { command: 'other', args: [target] } }));
      expect(run().outcome).toBe('skipped');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

});
