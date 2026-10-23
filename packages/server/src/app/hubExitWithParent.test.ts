import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_WITH_PID_ENV, parseExitWithPid, startHubExitWithParent } from './hubExitWithParent';

describe('parseExitWithPid', () => {
  it('is undefined when the setting is absent', () => {
    expect(parseExitWithPid({})).toBeUndefined();
  });

  it('reads a process id', () => {
    expect(parseExitWithPid({ [EXIT_WITH_PID_ENV]: '4242' })).toBe(4242);
  });

  it.each(['', '0', '-3', '12ab', '1.5', ' 7', '99999999999'])('refuses %j instead of treating it as not set', (value) => {
    expect(() => parseExitWithPid({ [EXIT_WITH_PID_ENV]: value })).toThrow(/process id/);
  });
});

describe('startHubExitWithParent', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const deps = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => ({
    hostEnv: { platform, systemRoot: undefined },
    env,
    onGone: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  });

  it('follows nothing when the hub was not started by the task', () => {
    expect(startHubExitWithParent(deps({}, 'win32'))).toBeUndefined();
  });

  it('refuses the setting on another OS', () => {
    expect(() => startHubExitWithParent(deps({ [EXIT_WITH_PID_ENV]: '4242' }, 'linux'))).toThrow(/only for the Windows/);
  });

  it('calls onGone when the followed process does not exist', async () => {
    // A process id that no process holds (ids this large are not handed out), so the signal-0 probe fails.
    const d = deps({ [EXIT_WITH_PID_ENV]: '2147483646' }, 'win32');
    const watch = startHubExitWithParent(d);
    expect(watch).toBeDefined();
    await vi.advanceTimersByTimeAsync(3000);
    expect(d.onGone).toHaveBeenCalledTimes(1);
    watch?.stop();
  });
});
