import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SshClient, type SshClientEnv } from './SshClient';
import { resolveSshClientEnv } from './sshClientEnv';

describe('SshClient.resolveHost (the machine it runs on)', () => {
  let home: string;
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function clientWithHome(configText: string, overrides: Partial<SshClientEnv> = {}): SshClient {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-home-'));
    fs.mkdirSync(path.join(home, '.ssh'));
    fs.writeFileSync(path.join(home, '.ssh', 'config'), configText, 'utf8');
    return new SshClient({ homeDir: home, platform: process.platform, authSock: undefined, defaultUser: 'osuser', ...overrides });
  }

  it('reads config and keys from the given home, never from $HOME / the real home', () => {
    const client = clientWithHome('Host alias\n  HostName 10.1.1.1\n');
    fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'rsa');
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'ed');

    const resolved = client.resolveHost('u@alias');
    expect(resolved.host).toBe('10.1.1.1');
    expect(resolved.identityFile).toBe(path.join(home, '.ssh', 'id_ed25519'));
  });

  it('has no identity file when the home holds no default key', () => {
    expect(clientWithHome('').resolveHost('u@h').identityFile).toBeNull();
  });

  it('expands ~ in IdentityFile to the given home for / and \\ separators', () => {
    const client = clientWithHome('Host a\n  IdentityFile ~/.ssh/custom\nHost b\n  IdentityFile ~\\.ssh\\custom\nHost c\n  IdentityFile ~other/key\n');
    expect(client.resolveHost('u@a').identityFile).toBe(`${home}/.ssh/custom`);
    expect(client.resolveHost('u@b').identityFile).toBe(`${home}\\.ssh\\custom`);
    expect(client.resolveHost('u@c').identityFile).toBe('~other/key');
  });

  it('takes the user from user@host, then the ssh config User, then the OS user', () => {
    const client = clientWithHome('Host withuser\n  User cfguser\n');
    expect(client.resolveHost('explicit@withuser').username).toBe('explicit');
    expect(client.resolveHost('withuser').username).toBe('cfguser');
    expect(client.resolveHost('plainhost').username).toBe('osuser');
  });

  it('refuses to guess a user when there is none', () => {
    const client = clientWithHome('', { defaultUser: undefined });
    expect(() => client.resolveHost('plainhost')).toThrow(/No SSH user for "plainhost"/);
  });

  it('asks the ssh-agent resolution of the platform it was given', () => {
    expect(clientWithHome('', { authSock: '/run/agent.sock' }).resolveHost('u@h')).toMatchObject({ agent: '/run/agent.sock', agentUnavailableReason: null });
    expect(clientWithHome('', { platform: 'linux', authSock: undefined }).resolveHost('u@h')).toMatchObject({ agent: null, agentUnavailableReason: 'SSH_AUTH_SOCK is not set' });
  });
});

describe('resolveSshClientEnv', () => {
  it('reads the Windows user and the agent from USERNAME / SSH_AUTH_SOCK, with the home it was given', () => {
    expect(resolveSshClientEnv({ homeDir: 'C:\\Users\\alice', platform: 'win32' }, { USERNAME: 'alice', USER: 'wrong', HOME: 'C:\\wrong' })).toEqual({
      homeDir: 'C:\\Users\\alice',
      platform: 'win32',
      authSock: undefined,
      defaultUser: 'alice',
    });
  });

  it('reads USER (then LOGNAME) on Unix and an empty SSH_AUTH_SOCK is no agent', () => {
    expect(resolveSshClientEnv({ homeDir: '/home/bob', platform: 'linux' }, { USER: 'bob', SSH_AUTH_SOCK: '/s' })).toMatchObject({ defaultUser: 'bob', authSock: '/s' });
    expect(resolveSshClientEnv({ homeDir: '/home/bob', platform: 'darwin' }, { LOGNAME: 'carol', SSH_AUTH_SOCK: '' })).toMatchObject({ defaultUser: 'carol', authSock: undefined });
  });
});
