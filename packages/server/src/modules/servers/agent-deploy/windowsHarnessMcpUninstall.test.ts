import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessMcpScript, parseHarnessMcpOutput } from './windowsHarnessMcpUninstall';

describe('Claude harness MCP removal', () => {
  it('removes only a matching entry and is safe to repeat', () => {
    const home = mkdtempSync(join(tmpdir(), 'azito-mcp-'));
    try {
      const settings = join(home, '.claude', 'settings.json');
      const target = join(home, 'index.js');
      mkdirSync(join(home, '.claude'));
      writeFileSync(target, '');
      writeFileSync(settings, JSON.stringify({ other: true, mcpServers: { 'azt-mcp': { command: 'node', args: [target], env: { TOKEN: 'secret' } }, other: { command: 'other' } } }));
      const script = harnessMcpScript('claude', process.execPath, home, target);
      const encoded = /FromBase64String\('([^']+)'\)/.exec(script)?.[1];
      expect(encoded).toBeDefined();
      const source = gunzipSync(Buffer.from(encoded!, 'base64')).toString('utf8');
      const run = () => parseHarnessMcpOutput(execFileSync(process.execPath, ['-e', source, 'claude', home, target], { encoding: 'utf8' }));
      expect(run().outcome).toBe('done');
      expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ other: true, mcpServers: { other: { command: 'other' } } });
      expect(run().outcome).toBe('absent');
      writeFileSync(settings, JSON.stringify({ mcpServers: { 'azt-mcp': { command: 'other', args: [target] } } }));
      expect(run().outcome).toBe('skipped');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
