import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecretFileGuard } from '../shared/os/secretFileGuard';
import { readEnvValue } from '../shared/envFile';
import { initEnvCommand, renderHubEnv } from './initEnvCommand';

const guard = createSecretFileGuard(process.platform, process.env);

describe('renderHubEnv', () => {
  it('writes values the hub reads back unchanged (a Windows path with spaces needs no quoting)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-env-render-'));
    try {
      const file = path.join(dir, '.env');
      fs.writeFileSync(file, renderHubEnv({ dataDir: 'C:\\Users\\Foo Bar\\.azito\\data', uiToken: 'abc', port: 3001, tailscaleDns: undefined }));
      expect(readEnvValue(file, 'AZITO_DATA_DIR')).toBe('C:\\Users\\Foo Bar\\.azito\\data');
      expect(readEnvValue(file, 'AZITO_UI_TOKEN')).toBe('abc');
      expect(readEnvValue(file, 'PORT')).toBe('3001');
      expect(readEnvValue(file, 'AZITO_PUBLIC_URL')).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds the MagicDNS origins and public URL when Tailscale reported a name', () => {
    const text = renderHubEnv({ dataDir: '/d', uiToken: 't', port: 3001, tailscaleDns: 'box.tail1.ts.net' });
    expect(text).toContain('AZITO_ALLOWED_ORIGINS=http://localhost:3001,http://127.0.0.1:3001,https://box.tail1.ts.net,http://box.tail1.ts.net:3001');
    expect(text).toContain('\nAZITO_PUBLIC_URL=https://box.tail1.ts.net\n');
  });

  it('writes PORT and every allowed origin with the requested port', () => {
    const text = renderHubEnv({ dataDir: '/d', uiToken: 't', port: 3010, tailscaleDns: 'box.tail1.ts.net' });
    expect(text).toContain('\nPORT=3010\n');
    expect(text).toContain('AZITO_ALLOWED_ORIGINS=http://localhost:3010,http://127.0.0.1:3010,https://box.tail1.ts.net,http://box.tail1.ts.net:3010\n');
    expect(text).not.toContain('3001');
  });
});

describe('initEnvCommand', () => {
  let prefix: string;
  beforeEach(() => { prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'init-env-')); });
  afterEach(() => fs.rmSync(prefix, { recursive: true, force: true }));

  it('creates data/ and hub/.env with a 64-hex token, and keeps an existing .env', () => {
    fs.mkdirSync(path.join(prefix, 'hub'));
    initEnvCommand(['--prefix', prefix, '--port', '3010', '--tailscale-dns', 'box.tail1.ts.net.'], guard);
    const envFile = path.join(prefix, 'hub', '.env');
    expect(fs.statSync(path.join(prefix, 'data')).isDirectory()).toBe(true);
    expect(readEnvValue(envFile, 'AZITO_DATA_DIR')).toBe(path.join(prefix, 'data'));
    expect(readEnvValue(envFile, 'AZITO_UI_TOKEN')).toMatch(/^[0-9a-f]{64}$/);
    expect(readEnvValue(envFile, 'AZITO_PUBLIC_URL')).toBe('https://box.tail1.ts.net');
    expect(readEnvValue(envFile, 'PORT')).toBe('3010');

    const before = fs.readFileSync(envFile, 'utf-8');
    initEnvCommand(['--prefix', prefix, '--port', '3999'], guard);
    expect(fs.readFileSync(envFile, 'utf-8')).toBe(before);
  });

  it('rejects a missing, relative or unknown argument instead of guessing', () => {
    expect(() => initEnvCommand([], guard)).toThrow(/Usage/);
    expect(() => initEnvCommand(['--prefix', prefix], guard)).toThrow(/Usage/);
    expect(() => initEnvCommand(['--prefix', 'relative/dir', '--port', '3001'], guard)).toThrow(/absolute/);
    expect(() => initEnvCommand(['--prefix', prefix, '--port', '3001', '--bogus', 'x'], guard)).toThrow(/Unknown option/);
    for (const bad of ['0', '65536', 'abc', '30.5', '-1']) {
      expect(() => initEnvCommand(['--prefix', prefix, '--port', bad], guard)).toThrow(/--port must be/);
    }
    expect(() => initEnvCommand(['--prefix'], guard)).toThrow(/needs a value/);
  });
});
