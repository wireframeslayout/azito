import { describe, expect, it } from 'vitest';
import { listProcessesWith } from './processList';
import { resolveCurrentHostEnv } from './hostEnv';
import { runCommandSpec, runHostOf } from '../exec/runCommandSpec';

/**
 * The real process list of the machine the tests run on (Linux, macOS and the Windows CI runner with its real powershell.exe 5.1):
 * this test process itself must be in it, with a start time that is plausible and a command line that names this node.
 */
describe('the process list of this host', () => {
  it('contains this process, with a start time, its parent and a command line', async () => {
    const hostEnv = resolveCurrentHostEnv();
    const before = Date.now();
    const list = await listProcessesWith(hostEnv.platform, (spec) => runCommandSpec(spec, runHostOf(hostEnv)));
    const after = Date.now();

    const self = list.find((p) => p.pid === process.pid);
    expect(self, 'this node process is in the list').toBeDefined();
    expect(self!.ppid).toBe(process.ppid);
    expect(self!.commandLine).toMatch(/node|vitest/i);
    if (hostEnv.platform === 'win32') expect(self!.executable?.toLowerCase()).toBe(process.execPath.toLowerCase());

    const processStart = Date.now() - process.uptime() * 1000;
    expect(self!.startMs).not.toBeNull();
    // ps has whole-second resolution; Windows gives the exact creation time. Allow a few seconds either way.
    expect(Math.abs(self!.startMs! - processStart)).toBeLessThan(5000);
    expect(self!.startMs!).toBeLessThanOrEqual(after);
    expect(before - self!.startMs!).toBeGreaterThanOrEqual(-5000);
    expect(self!.rssBytes ?? 0).toBeGreaterThan(0);
  }, 60_000);
});
