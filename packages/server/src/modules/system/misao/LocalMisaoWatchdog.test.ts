import { describe, expect, it } from 'vitest';
import type { RecoveryTiming } from '../../../shared/recoveryBackoff';
import { LocalMisaoWatchdog } from './LocalMisaoWatchdog';

const TIMING: RecoveryTiming = { tickMs: 15_000, baseMs: 60_000, maxMs: 240_000 };
const MIN = 60_000;

/** The hub's own misao, scripted, with a clock that moves only when told. */
class Harness {
  clock = 1_000_000;
  down = true;
  isDownFails: string | undefined;
  reviveResult = 'started';
  reviveFails = false;
  readonly revived: boolean[] = [];
  readonly logs: string[] = [];
  readonly watchdog = new LocalMisaoWatchdog({
    isDown: async () => {
      if (this.isDownFails) throw new Error(this.isDownFails);
      return this.down;
    },
    revive: async (force) => {
      this.revived.push(force);
      if (this.reviveFails) throw new Error('schtasks failed');
      if (this.reviveResult === 'started') this.down = false;
      return this.reviveResult;
    },
    now: () => this.clock,
    logger: { info: (m) => this.logs.push(`info: ${m}`), warn: (m) => this.logs.push(`warn: ${m}`) },
  }, TIMING);

  async advance(ms: number): Promise<void> {
    this.clock += ms;
    await this.watchdog.tick();
  }
}

describe('LocalMisaoWatchdog', () => {
  it('does nothing while the daemon answers', async () => {
    const h = new Harness();
    h.down = false;
    await h.watchdog.tick();
    await h.advance(10 * MIN);
    expect(h.revived).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it('waits out the base interval before the first attempt (an update or a start may be in the middle of it)', async () => {
    const h = new Harness();
    await h.watchdog.tick();
    expect(h.revived).toEqual([]);
    expect(h.logs[0]).toMatch(/trying to bring it back in 60s/);
    await h.advance(59_000);
    expect(h.revived).toEqual([]);
    await h.advance(1_000);
    expect(h.revived).toEqual([false]);
    expect(h.logs.at(-1)).toMatch(/attempt 1\): started/);
  });

  it('keeps the wait when the daemon does not come back: doubling up to the maximum, and ending a task that is still "running" from the second attempt on', async () => {
    const h = new Harness();
    h.reviveResult = 'starting';
    await h.watchdog.tick();
    const times: number[] = [];
    for (let elapsed = 0; elapsed < 12 * MIN; elapsed += 15_000) {
      const before = h.revived.length;
      await h.advance(15_000);
      if (h.revived.length > before) times.push(h.clock);
    }
    const gaps = times.slice(1).map((t, i) => (t - times[i]!) / MIN);
    expect(gaps.slice(0, 3)).toEqual([1, 2, 4]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(4);
    expect(h.revived[0]).toBe(false);
    expect(h.revived.slice(1).every((force) => force)).toBe(true);
  });

  it('starts over when the daemon answers again', async () => {
    const h = new Harness();
    h.reviveResult = 'starting';
    await h.watchdog.tick();
    await h.advance(MIN);
    expect(h.revived).toEqual([false]);
    h.down = false;
    await h.advance(15_000);
    h.down = true;
    await h.watchdog.tick();
    await h.advance(59_000);
    expect(h.revived).toEqual([false]);
    await h.advance(1_000);
    expect(h.revived).toEqual([false, false]);
  });

  it('is not an attempt when an install / update holds the slot (busy): it looks again at the next tick without doubling the wait', async () => {
    const h = new Harness();
    h.reviveResult = 'busy';
    await h.watchdog.tick();
    await h.advance(MIN);
    await h.advance(15_000);
    expect(h.revived).toEqual([false, false]);
    h.reviveResult = 'started';
    await h.advance(15_000);
    expect(h.revived).toEqual([false, false, false]);
  });

  it('warns once about an answer that waiting will not change, and stays quiet about a choice made by hand', async () => {
    const h = new Harness();
    h.reviveResult = 'other_task';
    await h.watchdog.tick();
    for (let i = 0; i < 40; i += 1) await h.advance(15_000);
    expect(h.logs.filter((l) => /cannot be started again \(other_task\)/.test(l))).toHaveLength(1);
    const quiet = new Harness();
    quiet.reviveResult = 'custom_socket';
    await quiet.watchdog.tick();
    for (let i = 0; i < 40; i += 1) await quiet.advance(15_000);
    expect(quiet.logs.filter((l) => /warn/.test(l))).toEqual([]);
  });

  it('says why an attempt failed and keeps going; says why it cannot look once', async () => {
    const h = new Harness();
    h.reviveFails = true;
    await h.watchdog.tick();
    await h.advance(MIN);
    expect(h.logs.some((l) => /warn: could not bring the misao back: schtasks failed/.test(l))).toBe(true);
    expect(h.revived).toEqual([false]);
    const blind = new Harness();
    blind.isDownFails = 'pipe status unreadable';
    await blind.watchdog.tick();
    await blind.advance(15_000);
    expect(blind.logs.filter((l) => /cannot tell whether the misao answers: pipe status unreadable/.test(l))).toHaveLength(1);
    expect(blind.revived).toEqual([]);
  });

  it('starts nothing once stopped', async () => {
    const h = new Harness();
    await h.watchdog.tick();
    h.watchdog.stop();
    await h.advance(10 * MIN);
    expect(h.revived).toEqual([]);
  });
});
