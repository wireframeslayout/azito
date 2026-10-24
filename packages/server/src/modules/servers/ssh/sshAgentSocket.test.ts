import { describe, it, expect } from 'vitest';
import { resolveSshAgent, WINDOWS_OPENSSH_AGENT_PIPE } from './sshAgentSocket';

describe('resolveSshAgent', () => {
  it('uses SSH_AUTH_SOCK on every OS without looking at the file system', () => {
    const exists = (): boolean => {
      throw new Error('must not be asked');
    };
    expect(resolveSshAgent('linux', '/run/user/1000/agent.sock', exists)).toEqual({ socket: '/run/user/1000/agent.sock', unavailableReason: null });
    expect(resolveSshAgent('win32', '\\\\.\\pipe\\custom-agent', exists)).toEqual({ socket: '\\\\.\\pipe\\custom-agent', unavailableReason: null });
    expect(resolveSshAgent('win32', 'pageant', exists)).toEqual({ socket: 'pageant', unavailableReason: null });
  });

  it.each(['linux', 'darwin'] as const)('has no agent on %s without SSH_AUTH_SOCK, and says so', (platform) => {
    expect(resolveSshAgent(platform, undefined, () => true)).toEqual({ socket: null, unavailableReason: 'SSH_AUTH_SOCK is not set' });
  });

  it('falls back to the OpenSSH agent pipe on Windows when the service has created it', () => {
    const asked: string[] = [];
    const result = resolveSshAgent('win32', undefined, (pipe) => {
      asked.push(pipe);
      return true;
    });
    expect(result).toEqual({ socket: WINDOWS_OPENSSH_AGENT_PIPE, unavailableReason: null });
    expect(asked).toEqual(['\\\\.\\pipe\\openssh-ssh-agent']);
  });

  it('reports a stopped ssh-agent service on Windows as "no agent", with the way to start it', () => {
    const result = resolveSshAgent('win32', undefined, () => false);
    expect(result.socket).toBeNull();
    expect(result.unavailableReason).toContain('\\\\.\\pipe\\openssh-ssh-agent');
    expect(result.unavailableReason).toContain('Start-Service ssh-agent');
  });
});
