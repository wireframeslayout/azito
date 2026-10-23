import { describe, expect, it, vi } from 'vitest';
import { AgentHostRecorder, HOST_READ_RETRY_MS } from './AgentHostRecorder';
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

type Info = { platform: string; arch: string; shell: string | null };

function setup(fetchHostInfo: () => Promise<Info>, stored: () => ServerConfig | null = () => agent()) {
  const repo = { updateHostProfile: vi.fn(), findByName: vi.fn(() => stored()) };
  const fetch = vi.fn(fetchHostInfo);
  const factory = { getAgentTransport: vi.fn(() => ({ fetchHostInfo: fetch })) };
  const clock = { t: 1_000 };
  const log = { warn: vi.fn() };
  return { recorder: new AgentHostRecorder(repo, factory as never, () => clock.t, log), repo, fetch, clock, log };
}

const LINUX: Info = { platform: 'linux', arch: 'x64', shell: '/bin/bash' };

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

  it('propagates an unreachable agent from an explicit record', async () => {
    const { recorder } = setup(async () => { throw new Error('Agent unreachable: timeout'); });
    await expect(recorder.record(agent())).rejects.toThrow('timeout');
  });

  describe('recordIfUnknown', () => {
    it('does not ask an agent whose host is recorded', async () => {
      const { recorder, fetch } = setup(async () => LINUX);
      const profile = { platform: 'linux' as const, arch: 'x64' as const };
      expect(await recorder.recordIfUnknown(agent({ hostProfile: profile }))).toEqual(profile);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('does not ask for a local server', async () => {
      const { recorder, fetch } = setup(async () => LINUX);
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
        return LINUX;
      });
      await recorder.recordIfUnknown(agent());
      expect(await recorder.record(agent())).toEqual({ platform: 'linux', arch: 'x64' });
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('shares one read between concurrent callers of the same server', async () => {
      let release!: (info: Info) => void;
      const { recorder, fetch } = setup(() => new Promise<Info>((resolve) => { release = resolve; }));
      const calls = [recorder.recordIfUnknown(agent()), recorder.recordIfUnknown(agent()), recorder.recordIfUnknown(agent())];
      release(LINUX);
      expect(await Promise.all(calls)).toEqual(Array(3).fill({ platform: 'linux', arch: 'x64' }));
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('does not throw on a failed read: it logs once, waits before asking again, and does not repeat the same warning', async () => {
      const { recorder, fetch, clock, log } = setup(async () => { throw new Error('Agent /api/host failed (500): boom'); });
      expect(await recorder.recordIfUnknown(agent())).toBeNull();
      expect(await recorder.recordIfUnknown(agent())).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledTimes(1);

      clock.t += HOST_READ_RETRY_MS;
      expect(await recorder.recordIfUnknown(agent())).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenCalledTimes(1);
    });

    it('recovers after the pause when the agent answers', async () => {
      let healthy = false;
      const { recorder, repo, clock } = setup(async () => { if (!healthy) throw new Error('down'); return LINUX; });
      await recorder.recordIfUnknown(agent());
      healthy = true;
      clock.t += HOST_READ_RETRY_MS;
      expect(await recorder.recordIfUnknown(agent())).toEqual({ platform: 'linux', arch: 'x64' });
      expect(repo.updateHostProfile).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the connection settings change', () => {
    it('forgets that an agent was too old once it is pointed at another address (the 404 memory is per settings)', async () => {
      let calls = 0;
      let stored = agent();
      const { recorder, fetch } = setup(async () => {
        calls += 1;
        if (calls === 1) throw new AgentHostOutdatedError('a1');
        return { platform: 'win32', arch: 'x64', shell: null };
      }, () => stored);
      expect(await recorder.recordIfUnknown(agent())).toBeNull();
      stored = agent({ host: '100.64.0.99' });
      expect(await recorder.recordIfUnknown(stored)).toEqual({ platform: 'win32', arch: 'x64' });
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('forget() drops the memory and the pause explicitly (PUT, delete)', async () => {
      const { recorder, fetch } = setup(async () => { throw new AgentHostOutdatedError('a1'); });
      await recorder.recordIfUnknown(agent());
      recorder.forget('a1');
      await recorder.recordIfUnknown(agent());
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('discards an answer that arrives after the server was pointed elsewhere, instead of storing the old host on the new target', async () => {
      let stored = agent();
      let release!: (info: Info) => void;
      const { recorder, repo } = setup(() => new Promise<Info>((resolve) => { release = resolve; }), () => stored);
      const pending = recorder.recordIfUnknown(agent());
      // PUT: the server now points at another machine while the old one is still being asked.
      stored = agent({ host: '100.64.0.99' });
      recorder.forget('a1');
      release({ platform: 'darwin', arch: 'arm64', shell: '/bin/zsh' });
      expect(await pending).toBeNull();
      expect(repo.updateHostProfile).not.toHaveBeenCalled();
    });

    it('discards it when only the stored settings changed (no forget needed), and when the server was deleted', async () => {
      let stored: ServerConfig | null = agent();
      let release!: (info: Info) => void;
      const { recorder, repo } = setup(() => new Promise<Info>((resolve) => { release = resolve; }), () => stored);
      const moved = recorder.record(agent());
      stored = agent({ agentPort: 4000 });
      release(LINUX);
      expect(await moved).toBeNull();

      const deleted = recorder.record(agent({ name: 'a2' }));
      stored = null;
      release(LINUX);
      expect(await deleted).toBeNull();
      expect(repo.updateHostProfile).not.toHaveBeenCalled();
    });

    it('an explicit record after an update is not poisoned by a late 404 from the read that was in flight before it', async () => {
      const pending: Array<{ resolve: (i: Info) => void; reject: (e: Error) => void }> = [];
      const { recorder, repo, fetch } = setup(() => new Promise<Info>((resolve, reject) => { pending.push({ resolve, reject }); }));
      const stale = recorder.recordIfUnknown(agent()); // the agent as it was before the update: slow
      const fresh = recorder.record(agent()); // the update succeeded: a new generation, with its own read
      expect(fetch).toHaveBeenCalledTimes(2);
      pending[0].reject(new AgentHostOutdatedError('a1')); // the old read answers 404 late
      await stale;
      pending[1].resolve(LINUX); // the new agent answers
      expect(await fresh).toEqual({ platform: 'linux', arch: 'x64' });
      expect(repo.updateHostProfile).toHaveBeenCalledWith('a1', { platform: 'linux', arch: 'x64' });
      // And it is not remembered as too old: an unrecorded host is asked again.
      const third = recorder.recordIfUnknown(agent());
      expect(fetch).toHaveBeenCalledTimes(3);
      pending[2].resolve(LINUX);
      await third;
    });

    it('does not remember a 404 that belongs to the old settings', async () => {
      let stored = agent();
      let release!: (e: Error) => void;
      const { recorder, fetch } = setup(() => new Promise<Info>((_resolve, reject) => { release = reject; }), () => stored);
      const first = recorder.recordIfUnknown(agent());
      stored = agent({ host: '100.64.0.99' });
      release(new AgentHostOutdatedError('a1'));
      await first;
      // The new target is asked; the old target's 404 does not stop it.
      const second = recorder.recordIfUnknown(stored);
      expect(fetch).toHaveBeenCalledTimes(2);
      release(new AgentHostOutdatedError('a1'));
      await second;
    });
  });
});
