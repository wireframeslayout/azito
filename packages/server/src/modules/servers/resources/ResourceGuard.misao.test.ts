import { describe, it, expect, vi } from 'vitest';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { ResourceGuard } from './ResourceGuard';
import { TransportFactory } from '../transport/TransportFactory';
import { LocalTransport } from '../transport/LocalTransport';
import type { ServerConfig } from '../Server';

const HEALTHY_STDOUT = '17179869184 8589934592\n8\n4.0 3.0 2.0 1/234 5678\n250000000000 500000000000\n';

describe('ResourceGuard with a misao local server', () => {
  it('measures through the shell transport through the same local transport as a tmux server', async () => {
    const exec = vi.spyOn(LocalTransport.prototype, 'exec').mockResolvedValue({ stdout: HEALTHY_STDOUT, stderr: '', code: 0 });
    const settingsRepo = { get: () => ({ enabled: true, memAvailablePercentMin: 10, loadPerCoreMax: 2 }), update: vi.fn() };
    const guard = new ResourceGuard(new TransportFactory('http://hub:3001'), settingsRepo as never);

    const misao = { name: 'm', type: 'local', host: null, agentPort: null, agentToken: null, defaultMux: 'misao' as const, muxRuntime: 'system' } as ServerConfig;
    const measurement = await guard.measure(misao);

    expect(exec).toHaveBeenCalled();
    expect(measurement?.memAvailablePercent).toBeCloseTo(50, 5);
    exec.mockRestore();
  });
});
