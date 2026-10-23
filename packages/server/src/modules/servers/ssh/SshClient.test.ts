import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import SSHConfig from 'ssh-config';
import { SshClient } from './SshClient';

const CONFIG_TEXT = `
Host alias
  HostName 10.0.0.1
  Port 2222
`;

function createClient(): SshClient {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-test-'));
  const configPath = path.join(dir, 'config');
  fs.writeFileSync(configPath, CONFIG_TEXT, 'utf8');
  return new SshClient(undefined, configPath);
}

describe('SshClient.resolveHost (user@host form)', () => {
  it('uses HostName and Port from ssh config for user@alias', () => {
    const resolved = createClient().resolveHost('user@alias');
    expect(resolved.host).toBe('10.0.0.1');
    expect(resolved.port).toBe(2222);
    expect(resolved.username).toBe('user');
  });

  it('prefers the explicit port over the ssh config Port', () => {
    const resolved = createClient().resolveHost('user@alias:9999');
    expect(resolved.host).toBe('10.0.0.1');
    expect(resolved.port).toBe(9999);
  });

  it('keeps the host and defaults to port 22 when no config matches', () => {
    const resolved = createClient().resolveHost('user@unknown');
    expect(resolved.host).toBe('unknown');
    expect(resolved.port).toBe(22);
  });

  it('keeps the explicit port when no config matches', () => {
    const resolved = createClient().resolveHost('user@unknown:3333');
    expect(resolved.host).toBe('unknown');
    expect(resolved.port).toBe(3333);
  });
});

describe('SshClient config reload on mtime change', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(configPath: string, content: string): void {
    fs.writeFileSync(configPath, content, 'utf8');
  }

  it('reloads config when file mtime changes', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-test-'));
    const configPath = path.join(tmpDir, 'config');
    writeConfig(configPath, 'Host srv1\n  HostName 10.0.0.1\n');

    const client = new SshClient(undefined, configPath);
    const r1 = client.resolveHost('user@srv1');
    expect(r1.host).toBe('10.0.0.1');

    writeConfig(configPath, 'Host srv1\n  HostName 10.0.0.2\n');
    // Ensure mtime is clearly different from the cached value
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(configPath, future, future);

    const r2 = client.resolveHost('user@srv1');
    expect(r2.host).toBe('10.0.0.2');
  });

  it('does not reload when mtime is unchanged', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-test-'));
    const configPath = path.join(tmpDir, 'config');
    writeConfig(configPath, 'Host srv1\n  HostName 10.0.0.1\n');
    // Pin mtime to a fixed value
    const pinned = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(configPath, pinned, pinned);

    const client = new SshClient(undefined, configPath);
    client.resolveHost('user@srv1');

    // Overwrite content but restore the same mtime
    writeConfig(configPath, 'Host srv1\n  HostName 10.0.0.99\n');
    fs.utimesSync(configPath, pinned, pinned);

    const r2 = client.resolveHost('user@srv1');
    expect(r2.host).toBe('10.0.0.1');
  });

  it('treats missing config file as empty (no crash)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-test-'));
    const configPath = path.join(tmpDir, 'nonexistent');

    const client = new SshClient(undefined, configPath);
    const resolved = client.resolveHost('user@somehost');
    expect(resolved.host).toBe('somehost');
    expect(resolved.port).toBe(22);
  });

  it('recovers when config file appears after being absent', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-test-'));
    const configPath = path.join(tmpDir, 'config');

    const client = new SshClient(undefined, configPath);
    const r1 = client.resolveHost('user@srv1');
    expect(r1.host).toBe('srv1');

    writeConfig(configPath, 'Host srv1\n  HostName 10.0.0.5\n');
    const r2 = client.resolveHost('user@srv1');
    expect(r2.host).toBe('10.0.0.5');
  });
});
