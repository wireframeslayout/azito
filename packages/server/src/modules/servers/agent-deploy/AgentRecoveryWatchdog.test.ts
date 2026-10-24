import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../Server';
import { KeyedMutex } from '../../../shared/keyedMutex';
import { AgentRecoveryWatchdog } from './AgentRecoveryWatchdog';
import type { RecoveryTiming } from '../../../shared/recoveryBackoff';

const TIMING: RecoveryTiming = { tickMs: 15_000, baseMs: 60_000, maxMs: 240_000 };
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
  reviveResult = 'started';
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
      return 'taskscheduler';
    },
    isMisaoDown: async () => { if (this.misaoStatusFails) throw new Error('older agent'); return this.misaoDown; },
    reviveMisao: async (s, force) => { this.revived.push({ name: s.name, force }); return this.reviveResult; },
    lock: this.lock,
    now: () => this.clock,
    logger: { info: (m) => this.logs.push(m), warn: (m) => this.logs.push(`WARN ${m}`) },
  }, TIMING);

  /** Holds the server's lock (an install in progress); resolves with the function that lets go. */
  async hold(name: string): Promise<() => void> {
    return new Promise<() => void>((resolve) => { void this.lock.withLock(name, () => new Promise<void>((done) => { resolve(done); })); });
  }

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

describe('AgentRecoveryWatchdog: the server as it is when the lock is got', () => {
  async function changedWhileWaiting(change: (h: Harness) => void): Promise<Harness> {
    const h = new Harness();
    h.agentUp = false;
    await h.watchdog.tick();
    h.clock += MIN;
    const release = await h.hold('win');
    const tick = h.watchdog.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    change(h);
    release();
    await tick;
    return h;
  }

  it.each([
    ['host', (h: Harness) => { h.servers = [{ ...server('win'), host: '100.64.0.77' } as ServerConfig]; }],
    ['token', (h: Harness) => { h.servers = [{ ...server('win'), agentToken: 'new' } as ServerConfig]; }],
    ['SSH host', (h: Harness) => { h.servers = [{ ...server('win'), sshHost: 'other@h' } as ServerConfig]; }],
  ])('starts over, without acting on the old %s, when it was edited while waiting for the lock', async (_what, change) => {
    const h = await changedWhileWaiting(change);
    expect(h.recovered).toEqual([]);
    // The new address gets its own base interval, counted from when it is first seen down.
    await h.advance(15_000);
    expect(h.recovered).toEqual([]);
    await h.advance(MIN);
    expect(h.recovered).toEqual(['win']);
  });

  it.each([
    ['is not a Windows host any more', (h: Harness) => { h.servers = [server('win', 'linux')]; }],
    ['is not an agent any more', (h: Harness) => { h.servers = [server('win', 'win32', 'local')]; }],
    ['was deleted', (h: Harness) => { h.servers = []; }],
  ])('does nothing when the server %s while waiting for the lock', async (_what, change) => {
    const h = await changedWhileWaiting(change);
    await h.advance(10 * MIN);
    expect(h.recovered).toEqual([]);
  });
});

describe('AgentRecoveryWatchdog: one server does not hold the others', () => {
  it('recovers B while A waits for its lock, and does not start a second look at A', async () => {
    const h = new Harness();
    h.servers = [server('a'), server('b')];
    h.agentUp = false;
    h.recoversToStart = 99;
    await h.watchdog.tick();
    h.clock += MIN;
    const release = await h.hold('a');
    const first = h.watchdog.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.recovered).toEqual(['b']); // A is stuck behind the lock, B went through
    await h.watchdog.tick(); // A is still being looked at: skipped; B is not due
    expect(h.recovered).toEqual(['b']);
    release();
    await first;
    expect(h.recovered).toEqual(['b', 'a']);
  });
});

describe('AgentRecoveryWatchdog: what a misao revive answers', () => {
  async function afterAttempts(result: string, attempts: number): Promise<Harness> {
    const h = new Harness();
    h.misaoDown = true;
    h.reviveResult = result;
    await h.watchdog.tick();
    let wait = MIN;
    for (let i = 0; i < attempts; i += 1) {
      await h.advance(wait);
      wait = Math.min(wait * 2, TIMING.maxMs);
    }
    return h;
  }

  it.each(['no_task', 'not_installed', 'other_task'])('warns once for %s, however many attempts', async (result) => {
    const h = await afterAttempts(result, 4);
    expect(h.revived.length).toBeGreaterThan(2);
    expect(h.logs.filter((l) => l.startsWith('WARN') && l.includes(result))).toHaveLength(1);
  });

  it.each(['disabled', 'custom_socket', 'running'])('says nothing for %s', async (result) => {
    const h = await afterAttempts(result, 3);
    expect(h.revived.length).toBeGreaterThan(1);
    expect(h.logs.filter((l) => !l.includes('trying to bring it back in'))).toEqual([]);
  });

  it('logs what it did when it started the task', async () => {
    const h = await afterAttempts('started', 1);
    expect(h.logs.some((l) => l.includes('tried to bring the misao back (attempt 1): started'))).toBe(true);
  });
});

describe('AgentRecoveryWatchdog: more servers than looks at once', () => {
  it('looks at every one of 6 servers, never more than 4 at the same time', async () => {
    const h = new Harness();
    h.servers = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => server(n));
    let active = 0;
    let most = 0;
    const checked = new Set<string>();
    const w = new AgentRecoveryWatchdog({
      listServers: () => h.servers,
      checkAgent: async (s: ServerConfig) => {
        active += 1;
        most = Math.max(most, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        checked.add(s.name);
        active -= 1;
      },
      recoverAgent: async () => 'taskscheduler',
      isMisaoDown: async () => false,
      reviveMisao: async () => 'started',
      lock: h.lock,
      now: () => h.clock,
      logger: { info: () => undefined, warn: () => undefined },
    }, TIMING);
    await w.tick();
    await w.tick();
    expect(most).toBeLessThanOrEqual(4);
    expect([...checked].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

describe('AgentRecoveryWatchdog: stopping', () => {
  it('does not recover what had not begun when it was stopped while waiting for the lock', async () => {
    const h = new Harness();
    h.agentUp = false;
    await h.watchdog.tick();
    h.clock += MIN;
    const release = await h.hold('win');
    const tick = h.watchdog.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.watchdog.stop();
    release();
    await tick;
    expect(h.recovered).toEqual([]);
    await h.watchdog.tick();
    expect(h.recovered).toEqual([]);
  });

  it('lets a recovery that had begun finish before drain() resolves', async () => {
    const h = new Harness();
    h.agentUp = false;
    await h.watchdog.tick();
    h.clock += MIN;
    let finished = false;
    h.duringRecover = async () => { await new Promise((resolve) => setTimeout(resolve, 30)); finished = true; };
    const tick = h.watchdog.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.recovered).toEqual(['win']);
    await h.watchdog.drain(1000);
    expect(finished).toBe(true);
    await tick;
  });

  it('gives up waiting for a recovery after the limit', async () => {
    const h = new Harness();
    h.agentUp = false;
    await h.watchdog.tick();
    h.clock += MIN;
    h.duringRecover = () => new Promise((resolve) => setTimeout(resolve, 300));
    const tick = h.watchdog.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const started = Date.now();
    await h.watchdog.drain(40);
    expect(Date.now() - started).toBeLessThan(250);
    await tick;
  });
});
