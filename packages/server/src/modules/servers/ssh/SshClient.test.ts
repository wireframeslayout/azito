import { describe, it, expect } from 'vitest';
import SSHConfig from 'ssh-config';
import { SshClient } from './SshClient';

const CONFIG_TEXT = `
Host alias
  HostName 10.0.0.1
  Port 2222
`;

function createClient(): SshClient {
  const client = new SshClient();
  (client as any).parsedConfig = SSHConfig.parse(CONFIG_TEXT);
  return client;
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
