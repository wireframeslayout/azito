import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResourceGuard, parseMeasurement, resourceCheckBody, measurementFromSample } from './ResourceGuard';
import { AgentResourcesOutdatedError, type HostResourceSample } from '../../../shared/os/hostResources';
import { AgentUnreachableError } from '../transport/AgentUnreachableError';
import { HostProfileError } from '../../../shared/os/hostProfile';
import type { ServerConfig } from '../Server';

const server = { name: 'local', type: 'local' } as ServerConfig;

function makeGuard(opts: {
  stdout?: string;
  code?: number;
  execError?: boolean;
  enabled?: boolean;
  memMin?: number;
  loadMax?: number;
}) {
  const exec = opts.execError
    ? vi.fn(async () => { throw new Error('exec failed'); })
    : vi.fn(async () => ({ stdout: opts.stdout ?? '', stderr: '', code: opts.code ?? 0 }));
  const transportFactory = { hostProfileFor: () => null, getTransport: vi.fn(() => ({ exec })) };
  const settingsRepo = {
    get: vi.fn(() => ({
      enabled: opts.enabled ?? true,
      memAvailablePercentMin: opts.memMin ?? 10,
      loadPerCoreMax: opts.loadMax ?? 2.0,
    })),
    update: vi.fn(),
  };
  const guard = new ResourceGuard(transportFactory as never, settingsRepo as never);
  return { guard, exec, settingsRepo };
}

// 空きメモリ50% (16GB中8GB)、load1=4.0、8コア → loadPerCore=0.5、disk 50%
const HEALTHY_STDOUT = '17179869184 8589934592\n8\n4.0 3.0 2.0 1/234 5678\n250000000000 500000000000\n';
// 空きメモリ5%、load1=24.0、8コア → loadPerCore=3.0
const EXHAUSTED_STDOUT = '17179869184 858993459\n8\n24.0 20.0 18.0 1/234 5678\n';

describe('parseMeasurement', () => {
  it('parses valid output', () => {
    const m = parseMeasurement(HEALTHY_STDOUT);
    expect(m).not.toBeNull();
    expect(m!.memAvailablePercent).toBeCloseTo(50, 5);
    expect(m!.loadPerCore).toBeCloseTo(0.5, 5);
    expect(m!.memTotalBytes).toBe(17179869184);
    expect(m!.memAvailableBytes).toBe(8589934592);
    expect(m!.diskUsedPercent).toBeCloseTo(50, 5);
    expect(m!.diskUsedBytes).toBe(250000000000);
    expect(m!.diskTotalBytes).toBe(500000000000);
  });

  // Captured from a real macOS 26 host. `sysctl -n vm.loadavg` prints
  // "{ 1.60 1.63 1.60 }", so the load line arrives with the braces stripped and
  // a leading space — the parser has to survive that.
  it('parses macOS output, whose load line is space-padded', () => {
    const m = parseMeasurement('17179869184 4340088832\n10\n 1.60 1.63 1.60 \n17837785088 245107195904\n');
    expect(m).not.toBeNull();
    expect(m!.memAvailablePercent).toBeCloseTo(25.26, 1);
    expect(m!.loadPerCore).toBeCloseTo(0.16, 2);
    expect(m!.diskUsedPercent).toBeCloseTo(7.28, 1);
  });

  it('returns null when lines are missing', () => {
    expect(parseMeasurement('')).toBeNull();
    expect(parseMeasurement('17179869184 8589934592\n8\n')).toBeNull();
  });

  it('returns null on non-numeric values', () => {
    expect(parseMeasurement('total avail\n8\n0.5 0.4 0.3\n')).toBeNull();
    expect(parseMeasurement('17179869184 8589934592\nabc\n0.5 0.4 0.3\n')).toBeNull();
    expect(parseMeasurement('17179869184 8589934592\n8\nx y z\n')).toBeNull();
  });

  it('returns null on zero total memory or zero cores', () => {
    expect(parseMeasurement('0 0\n8\n0.5 0.4 0.3\n')).toBeNull();
    expect(parseMeasurement('17179869184 8589934592\n0\n0.5 0.4 0.3\n')).toBeNull();
  });

  it('accepts zero available memory and zero load', () => {
    const m = parseMeasurement('17179869184 0\n8\n0.0 0.0 0.0\n');
    expect(m).toEqual({
      memAvailablePercent: 0,
      loadPerCore: 0,
      memTotalBytes: 17179869184,
      memAvailableBytes: 0,
      diskUsedPercent: null,
      diskUsedBytes: null,
      diskTotalBytes: null,
    });
  });

  it('parses output without disk info (df unavailable)', () => {
    const m = parseMeasurement('17179869184 8589934592\n8\n4.0 3.0 2.0 1/234 5678\n');
    expect(m).not.toBeNull();
    expect(m!.diskUsedPercent).toBeNull();
    expect(m!.diskUsedBytes).toBeNull();
    expect(m!.diskTotalBytes).toBeNull();
  });
});

describe('ResourceGuard.check', () => {
  it('returns ok when resources are healthy', async () => {
    const { guard } = makeGuard({ stdout: HEALTHY_STDOUT });
    const status = await guard.check(server);
    expect(status.ok).toBe(true);
    expect(status.reasons).toEqual([]);
    expect(status.memAvailablePercent).toBeCloseTo(50, 5);
  });

  it('reports both memory and load reasons when exhausted', async () => {
    const { guard } = makeGuard({ stdout: EXHAUSTED_STDOUT });
    const status = await guard.check(server);
    expect(status.ok).toBe(false);
    expect(status.reasons).toEqual(['memory', 'load']);
    expect(status.memAvailablePercentMin).toBe(10);
    expect(status.loadPerCoreMax).toBe(2.0);
  });

  it('reports only memory when only memory is below threshold', async () => {
    // 空きメモリ5%、loadPerCore=0.5
    const { guard } = makeGuard({ stdout: '17179869184 858993459\n8\n4.0 3.0 2.0\n' });
    const status = await guard.check(server);
    expect(status.reasons).toEqual(['memory']);
  });

  it('boundary values equal to thresholds are ok', async () => {
    // 空きメモリちょうど10%、loadPerCore ちょうど2.0
    const { guard } = makeGuard({ stdout: '17179869184 1717986918.4\n8\n16.0 0 0\n' });
    const status = await guard.check(server);
    expect(status.ok).toBe(true);
  });

  it('skips measurement entirely when disabled', async () => {
    const { guard, exec } = makeGuard({ enabled: false, stdout: EXHAUSTED_STDOUT });
    const status = await guard.check(server);
    expect(status.ok).toBe(true);
    expect(status.memAvailablePercent).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it('fails open when exec throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { guard } = makeGuard({ execError: true });
    const status = await guard.check(server);
    expect(status.ok).toBe(true);
    expect(status.memAvailablePercent).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fail-open'));
    expect(status.skipped).toEqual({ reason: 'failed' });
    warn.mockRestore();
  });

  it('fails open when exec exits non-zero', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { guard } = makeGuard({ stdout: 'whatever', code: 127 });
    const status = await guard.check(server);
    expect(status.ok).toBe(true);
    warn.mockRestore();
  });

  it('fails open when output is unparsable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { guard } = makeGuard({ stdout: 'command not found' });
    const status = await guard.check(server);
    expect(status.ok).toBe(true);
    warn.mockRestore();
  });
});

describe('ResourceGuard.measure cache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('caches measurements per server for 5 seconds', async () => {
    const { guard, exec } = makeGuard({ stdout: HEALTHY_STDOUT });
    await guard.measure(server);
    await guard.measure(server);
    expect(exec).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5001);
    await guard.measure(server);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('caches null results (failed measurement) too', async () => {
    const { guard, exec } = makeGuard({ execError: true });
    expect((await guard.measure(server)).measurement).toBeNull();
    expect((await guard.measure(server)).measurement).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('shares a single in-flight measurement across concurrent callers', async () => {
    let resolveExec!: (value: { stdout: string; stderr: string; code: number }) => void;
    const exec = vi.fn(() => new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      resolveExec = resolve;
    }));
    const transportFactory = { hostProfileFor: () => null, getTransport: vi.fn(() => ({ exec })) };
    const settingsRepo = {
      get: vi.fn(() => ({ enabled: true, memAvailablePercentMin: 10, loadPerCoreMax: 2.0 })),
      update: vi.fn(),
    };
    const guard = new ResourceGuard(transportFactory as never, settingsRepo as never);

    const results = Promise.all([guard.measure(server), guard.measure(server)]);
    resolveExec({ stdout: HEALTHY_STDOUT, stderr: '', code: 0 });
    const [first, second] = await results;

    expect(exec).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it('returns null after 10s when exec never resolves', async () => {
    const exec = vi.fn(() => new Promise(() => {})); // never resolves
    const transportFactory = { hostProfileFor: () => null, getTransport: vi.fn(() => ({ exec })) };
    const settingsRepo = {
      get: vi.fn(() => ({ enabled: true, memAvailablePercentMin: 10, loadPerCoreMax: 2.0 })),
      update: vi.fn(),
    };
    const guard = new ResourceGuard(transportFactory as never, settingsRepo as never);

    const promise = guard.measure(server);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await promise).toEqual({ measurement: null, unavailable: { reason: 'timeout' } });
  });
});


describe('ResourceGuard.check skipped', () => {
  it('has no skipped when the check was made or the guard is disabled', async () => {
    expect((await makeGuard({ stdout: HEALTHY_STDOUT }).guard.check(server)).skipped).toBeNull();
    expect((await makeGuard({ enabled: false }).guard.check(server)).skipped).toBeNull();
  });

  it('names the reason of a skipped check, still fail-open', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const status = await makeGuard({ stdout: 'command not found' }).guard.check(server);
    expect(status).toMatchObject({ ok: true, reasons: [], skipped: { reason: 'failed' } });
    warn.mockRestore();
  });

  it('logs a server that stays unmeasurable once per reason', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { guard } = makeGuard({ execError: true });
    await guard.check(server);
    vi.advanceTimersByTime(6000);
    await guard.check(server);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    vi.useRealTimers();
  });

  it('resourceCheckBody carries only a skipped check', () => {
    expect(resourceCheckBody(null)).toEqual({});
    expect(resourceCheckBody({ reason: 'unreachable' })).toEqual({ resourceCheck: { skipped: { reason: 'unreachable' } } });
  });
});

const SAMPLE: HostResourceSample = { memTotalBytes: 16_000, memAvailableBytes: 8_000, disk: { usedBytes: 100, totalBytes: 400 } };

function makeHostGuard(opts: { platform: 'win32' | 'linux' | 'darwin' | null; type?: 'local' | 'agent'; measureHostResources?: () => Promise<HostResourceSample>; memMin?: number; loadMax?: number }) {
  const exec = vi.fn(async () => ({ stdout: HEALTHY_STDOUT, stderr: '', code: 0 }));
  const measureHostResources = vi.fn(opts.measureHostResources ?? (async () => SAMPLE));
  const transportFactory = {
    hostProfileFor: vi.fn(() => (opts.platform ? { platform: opts.platform, arch: 'x64' } : null)),
    getTransport: vi.fn(() => ({ exec, measureHostResources })),
  };
  const settingsRepo = { get: vi.fn(() => ({ enabled: true, memAvailablePercentMin: opts.memMin ?? 10, loadPerCoreMax: opts.loadMax ?? 2.0 })), update: vi.fn() };
  const guard = new ResourceGuard(transportFactory as never, settingsRepo as never);
  const srv = { name: 'h', type: opts.type ?? 'local' } as ServerConfig;
  return { guard, exec, measureHostResources, srv };
}

describe('ResourceGuard by the host OS', () => {
  it('measures a win32 local host with Node (no sh), without a load', async () => {
    const { guard, exec, measureHostResources, srv } = makeHostGuard({ platform: 'win32' });
    const result = await guard.measure(srv);
    expect(exec).not.toHaveBeenCalled();
    expect(measureHostResources).toHaveBeenCalledTimes(1);
    expect(result.measurement).toEqual({
      memAvailablePercent: 50, loadPerCore: null, memTotalBytes: 16_000, memAvailableBytes: 8_000,
      diskUsedPercent: 25, diskUsedBytes: 100, diskTotalBytes: 400,
    });
    expect(result.unavailable).toBeNull();
  });

  it('measures a win32 agent through the agent API', async () => {
    const { guard, exec, measureHostResources, srv } = makeHostGuard({ platform: 'win32', type: 'agent' });
    expect((await guard.measure(srv)).measurement?.memAvailablePercent).toBe(50);
    expect(measureHostResources).toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('reports a 404 of the agent API as agent_outdated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { guard, srv } = makeHostGuard({ platform: 'win32', type: 'agent', measureHostResources: async () => { throw new AgentResourcesOutdatedError('h'); } });
    expect(await guard.measure(srv)).toEqual({ measurement: null, unavailable: { reason: 'agent_outdated' } });
    expect((await guard.check(srv)).skipped).toEqual({ reason: 'agent_outdated' });
    warn.mockRestore();
  });

  it('reports an unreachable agent as unreachable', async () => {
    const { guard, srv } = makeHostGuard({ platform: 'win32', type: 'agent', measureHostResources: async () => { throw new AgentUnreachableError('h', 'circuit_open'); } });
    expect((await guard.measure(srv)).unavailable).toEqual({ reason: 'unreachable' });
  });

  it('reports a host the transport refuses to measure as unsupported_os', async () => {
    const { guard, srv } = makeHostGuard({ platform: 'win32', measureHostResources: async () => { throw new HostProfileError('unsupported_os', 'no'); } });
    expect((await guard.measure(srv)).unavailable).toEqual({ reason: 'unsupported_os' });
  });

  it.each(['linux', 'darwin', null] as const)('keeps the sh measurement on %s (and on an agent with no recorded OS)', async (platform) => {
    const { guard, exec, measureHostResources, srv } = makeHostGuard({ platform });
    const result = await guard.measure(srv);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(measureHostResources).not.toHaveBeenCalled();
    expect(result.measurement?.loadPerCore).toBeCloseTo(0.5, 5);
  });

  it('judges only the memory when the host has no load', async () => {
    const low = makeHostGuard({ platform: 'win32', measureHostResources: async () => ({ ...SAMPLE, memAvailableBytes: 800 }) });
    expect((await low.guard.check(low.srv)).reasons).toEqual(['memory']);
    // a load limit that would trip on any real load never trips without one
    const ok = makeHostGuard({ platform: 'win32', loadMax: 0.0001 });
    const status = await ok.guard.check(ok.srv);
    expect(status).toMatchObject({ ok: true, reasons: [], loadPerCore: null, skipped: null });
  });

  it('measurementFromSample leaves the disk null when it was not read', () => {
    expect(measurementFromSample({ ...SAMPLE, disk: null })).toMatchObject({ diskUsedPercent: null, diskUsedBytes: null, diskTotalBytes: null });
  });
});
