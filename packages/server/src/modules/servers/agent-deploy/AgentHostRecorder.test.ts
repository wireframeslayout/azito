import { describe, expect, it, vi } from 'vitest';
import { AgentHostRecorder } from './AgentHostRecorder';
import { AgentHostOutdatedError } from '../transport/agentHostProtocol';
import type { ServerConfig } from '../Server';

function agent(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: 'a1', type: 'agent', host: '100.64.0.2', hostProfile: null, agentPort: 3002, agentToken: 'tok', agentVersion: 'v', sshHost: null,
    sshHostFingerprint: null, defaultMux: 'tmux', muxRuntime: 'system', isolationIntent: false, isolationVerifiedAt: null,
    isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01',
    ...overrides,
  };
}

function setup(fetchHostInfo: () => Promise<{ platform: string; arch: string; shell: string | null }>) {
  const repo = { updateHostProfile: vi.fn() };
  const fetch = vi.fn(fetchHostInfo);
  const factory = { getAgentTransport: vi.fn(() => ({ fetchHostInfo: fetch })) };
  return { recorder: new AgentHostRecorder(repo, factory as never), repo, fetch };
}

describe('AgentHostRecorder', () => {
  it('stores what the agent reports', async () => {
    const { recorder, repo } = setup(async () => ({ platform: 'darwin', arch: 'arm64', shell: '/bin/zsh' }));
    expect(await recorder.record(agent())).toEqual({ platform: 'darwin', arch: 'arm64' });
    expect(repo.updateHostProfile).toHaveBeenCalledWith('a1', { platform: 'darwin', arch: 'arm64' });
  });

  it('stores nothing and rejects with unsupported_host for an OS AZITO does not support', async () => {
    const { recorder, repo } = setup(async () => ({ platform: 'freebsd', arch: 'x64', shell: null }));
    await expect(recorder.record(agent())).rejects.toMatchObject({ code: 'unsupported_host' });
    expect(repo.updateHostProfile).not.toHaveBeenCalled();
  });

  it('leaves the host unrecorded for an agent without the endpoint (agent_outdated), without failing', async () => {
    const { recorder, repo } = setup(async () => { throw new AgentHostOutdatedError('a1'); });
    expect(await recorder.record(agent())).toBeNull();
    expect(repo.updateHostProfile).not.toHaveBeenCalled();
  });

  it('propagates an unreachable agent', async () => {
    const { recorder } = setup(async () => { throw new Error('Agent unreachable: timeout'); });
    await expect(recorder.record(agent())).rejects.toThrow('timeout');
  });

  describe('recordIfUnknown', () => {
    it('does not ask an agent whose host is recorded', async () => {
      const { recorder, fetch } = setup(async () => ({ platform: 'linux', arch: 'x64', shell: '/bin/sh' }));
      const profile = { platform: 'linux' as const, arch: 'x64' as const };
      expect(await recorder.recordIfUnknown(agent({ hostProfile: profile }))).toEqual(profile);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('does not ask for a local server', async () => {
      const { recorder, fetch } = setup(async () => ({ platform: 'linux', arch: 'x64', shell: '/bin/sh' }));
      expect(await recorder.recordIfUnknown(agent({ type: 'local' }))).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('asks once for an unrecorded agent, and not again while it is known to be too old (status polls)', async () => {
      const { recorder, fetch } = setup(async () => { throw new AgentHostOutdatedError('a1'); });
      await recorder.recordIfUnknown(agent());
      await recorder.recordIfUnknown(agent());
      await recorder.recordIfUnknown(agent());
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('asks again after an explicit record (an update may have fixed it)', async () => {
      let calls = 0;
      const { recorder, fetch } = setup(async () => {
        calls += 1;
        if (calls === 1) throw new AgentHostOutdatedError('a1');
        return { platform: 'linux', arch: 'x64', shell: '/bin/bash' };
      });
      await recorder.recordIfUnknown(agent());
      expect(await recorder.record(agent())).toEqual({ platform: 'linux', arch: 'x64' });
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });
});
