import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../Server';
import { KeyedMutex } from '../../../shared/keyedMutex';
import { AgentRecoveryWatchdog, type AgentRecoveryTiming } from './AgentRecoveryWatchdog';

const TIMING: AgentRecoveryTiming = { tickMs: 15_000, baseMs: 60_000, maxMs: 240_000 };
const MIN = 60_000;

function server(name: string, platform: 'win32' | 'linux' = 'win32', type: ServerConfig['type'] = 'agent'): ServerConfig {
  return { name, type, host: '100.64.0.9', agentPort: 3002, agentToken: 't', sshHost: 'u@h', hostProfile: { platform, arch: 'x64' } } as unknown as ServerConfig;
}

/** A hub whose servers, agents and misao are scripted, and whose clock moves only when told. */
class Harness {
  clock = 1_000_000;
  servers: ServerConfig[] = [server('win')];
  agentUp = true;
  misaoDown = false;
  misaoStatusFails = false;
  recoverFails = false;
  /** The agent is up again once recoverAgent was called this many times. */
  recoversToStart = 1;
  readonly recovered: string[] = [];
  readonly revived: Array<{ name: string; force: boolean }> = [];
  readonly logs: string[] = [];
  readonly lock = new KeyedMutex();
  /** Runs while a recovery holds the lock. */
  duringRecover: (() => Promise<void>) | undefined;

  readonly watchdog = new AgentRecoveryWatchdog({
    listServers: () => this.servers,
    checkAgent: async () => { if (!this.agentUp) throw new Error('unreachable'); },
    recoverAgent: async (s) => {
      this.recovered.push(s.name);
      await this.duringRecover?.();
      if (this.recoverFails) throw new Error('ssh failed');
      if (this.recovered.length >= this.recoversToStart) this.agentUp = true;
    },
    isMisaoDown: async () => { if (this.misaoStatusFails) throw new Error('older agent'); return this.misaoDown; },
    reviveMisao: async (s, force) => { this.revived.push({ name: s.name, force }); },
    lock: this.lock,
    now: () => this.clock,
    logger: { info: (m) => this.logs.push(m), warn: (m) => this.logs.push(`WARN ${m}`) },
  }, TIMING);

  async advance(ms: number): Promise<void> {
    this.clock += ms;
    await this.watchdog.tick();
  }
}

describe('AgentRecoveryWatchdog: the agent', () => {
  it('does nothing while the agent answers', async () => {
    const h = new Harness();
    await h.watchdog.tick();
    await h.advance(10 * MIN);
    expect(h.recovered).toEqual([]);
  });

  it('waits out the base interval after the first failure, then brings the agent back', async () => {
    const h = new Harness();
    h.agentUp = false;
    await h.watchdog.tick(); // seen down: nothing yet
    await h.advance(30_000);
    expect(h.recovered).toEqual([]);
    await h.advance(30_000);
    expect(h.recovered).toEqual(['win']);
    expect(h.agentUp).toBe(true);
  });

  it('doubles the wait up to the limit while the agent stays down', async () => {
    const h = new Harness();
    h.agentUp = false;
    h.recoversToStart = 99;
    await h.watchdog.tick();
    const at: number[] = [];
    const start = h.clock;
    for (let i = 0; i < 20 * 4; i += 1) {
      const before = h.recovered.length;
      await h.advance(15_000);
      if (h.recovered.length > before) at.push(h.clock - start);
    }
    // 1 min after it was seen down, then waits of 1, 2, 4 minutes (the limit), 4, ...
    expect(at.slice(0, 6)).toEqual([MIN, 2 * MIN, 4 * MIN, 8 * MIN, 12 * MIN, 16 * MIN]);
  });

  it('forgets everything when the agent answers, so that the next failure starts from the base interval again', async () => {
    const h = new Harness();
    h.agentUp = false;
    h.recoversToStart = 99;
    await h.watchdog.tick();
    await h.advance(MIN);
    await h.advance(2 * MIN);
    expect(h.recovered).toHaveLength(2);
    h.agentUp = true;
    await h.advance(15_000);
    h.agentUp = false;
    await h.watchdog.tick();
    await h.advance(MIN - 15_000);
    expect(h.recovered).toHaveLength(2);
    await h.advance(15_000);
    expect(h.recovered).toHaveLength(3);
  });

  it('keeps going after a recovery that throws, and says why', async () => {
    const h = new Harness();
    h.agentUp = false;
    h.recoverFails = true;
    await h.watchdog.tick();
    await h.advance(MIN);
    await h.advance(2 * MIN);
    expect(h.recovered).toHaveLength(2);
    expect(h.logs.some((l) => l.startsWith('WARN win: could not bring the agent back: ssh failed'))).toBe(true);
  });

  it('only looks at Windows agents', async () => {
    const h = new Harness();
    h.servers = [server('unix', 'linux'), server('local', 'win32', 'local'), server('other', 'win32', 'local')];
    h.agentUp = false;
    await h.watchdog.tick();
    await h.advance(10 * MIN);
    expect(h.recovered).toEqual([]);
  });

  it('stops trying for a server that was deleted, and looks again under the lock', async () => {
    const h = new Harness();
    h.agentUp = false;
    await h.watchdog.tick();
    h.clock += MIN;
    h.servers = [];
    await h.watchdog.tick();
    expect(h.recovered).toEqual([]);

    // Deleted between the look and the lock: the attempt is dropped.
    h.servers = [server('win')];
    await h.watchdog.tick();
    h.clock += MIN;
    const release = await new Promise<() => void>((resolve) => { void h.lock.withLock('win', () => new Promise<void>((done) => { resolve(done); })); });
    const tick = h.watchdog.tick();
    h.servers = [];
    release();
    await tick;
    expect(h.recovered).toEqual([]);
  });

  it('does not try while an install holds the lock, and finds the agent up when it gets the lock', async () => {
    const h = new Harness();
    h.agentUp = false;
    await h.watchdog.tick();
    h.clock += MIN;
    const release = await new Promise<() => void>((resolve) => { void h.lock.withLock('win', () => new Promise<void>((done) => { resolve(done); })); });
    const tick = h.watchdog.tick();
    await Promise.resolve();
    expect(h.recovered).toEqual([]);
    h.agentUp = true; // the install brought it up
    release();
    await tick;
    expect(h.recovered).toEqual([]);
  });

  it('never runs two looks at once', async () => {
    const h = new Harness();
    h.agentUp = false;
    await h.watchdog.tick();
    h.clock += MIN;
    let inside = 0;
    let maxInside = 0;
    h.duringRecover = async () => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inside -= 1;
    };
    await Promise.all([h.watchdog.tick(), h.watchdog.tick(), h.watchdog.tick()]);
    expect(maxInside).toBe(1);
    expect(h.recovered).toHaveLength(1);
  });

  it('stop() ends the timer', async () => {
    const h = new Harness();
    h.watchdog.start();
    h.watchdog.start();
    h.watchdog.stop();
    h.watchdog.stop();
  });
});

describe('AgentRecoveryWatchdog: the misao on a reachable agent', () => {
  it('starts the misao task again after the base interval, the same way as an agent', async () => {
    const h = new Harness();
    h.misaoDown = true;
    await h.watchdog.tick();
    expect(h.revived).toEqual([]);
    await h.advance(MIN);
    expect(h.revived).toEqual([{ name: 'win', force: false }]);
  });

  it('ends a task that stays "running" without a daemon on the later attempts, and doubles the wait', async () => {
    const h = new Harness();
    h.misaoDown = true;
    await h.watchdog.tick();
    await h.advance(MIN);
    await h.advance(MIN - 15_000);
    expect(h.revived).toHaveLength(1);
    await h.advance(15_000);
    expect(h.revived).toEqual([{ name: 'win', force: false }, { name: 'win', force: true }]);
    await h.advance(2 * MIN - 15_000);
    expect(h.revived).toHaveLength(2);
    await h.advance(15_000);
    expect(h.revived).toHaveLength(3);
  });

  it('does nothing when the daemon answers, when AZITO did not install it, or when the agent cannot say', async () => {
    const h = new Harness();
    await h.advance(10 * MIN);
    h.misaoStatusFails = true;
    await h.advance(10 * MIN);
    expect(h.revived).toEqual([]);
  });

  it('stops and starts over when the misao answers again', async () => {
    const h = new Harness();
    h.misaoDown = true;
    await h.watchdog.tick();
    await h.advance(MIN);
    h.misaoDown = false;
    await h.advance(15_000);
    h.misaoDown = true;
    await h.watchdog.tick();
    await h.advance(MIN);
    expect(h.revived).toEqual([{ name: 'win', force: false }, { name: 'win', force: false }]);
  });

  it('leaves the misao alone while the agent itself is down (the agent comes first)', async () => {
    const h = new Harness();
    h.agentUp = false;
    h.misaoDown = true;
    await h.watchdog.tick();
    await h.advance(MIN);
    expect(h.revived).toEqual([]);
    expect(h.recovered).toEqual(['win']);
  });

  it('serves each server by itself', async () => {
    const h = new Harness();
    h.servers = [server('a'), server('b')];
    h.misaoDown = true;
    await h.watchdog.tick();
    await h.advance(MIN);
    expect(h.revived.map((r) => r.name)).toEqual(['a', 'b']);
  });
});
