import { describe, it, expect, vi } from 'vitest';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { ResourceGuard } from './ResourceGuard';
import { TransportFactory } from '../transport/TransportFactory';
import type { ServerConfig } from '../Server';

const HEALTHY_STDOUT = '17179869184 8589934592\n8\n4.0 3.0 2.0 1/234 5678\n250000000000 500000000000\n';

describe('ResourceGuard with a misao server whose driver is unavailable', () => {
  it('measures the misao server as null while other servers keep their measurement', async () => {
    const real = new TransportFactory('http://hub:3001');
    const exec = vi.fn(async () => ({ stdout: HEALTHY_STDOUT, stderr: '', code: 0 }));
    const factory = {
      getTransport: (server: ServerConfig) => (server.muxRuntime === 'misao' ? real.getTransport(server) : { exec }),
    };
    const settingsRepo = { get: () => ({ enabled: true, memAvailablePercentMin: 10, loadPerCoreMax: 2 }), update: vi.fn() };
    const guard = new ResourceGuard(factory as never, settingsRepo as never);

    const misao = { name: 'm', type: 'local', host: null, agentPort: null, agentToken: null, muxRuntime: 'misao' } as ServerConfig;
    const tmux = { name: 't', type: 'local', host: null, agentPort: null, agentToken: null, muxRuntime: 'system' } as ServerConfig;

    const [misaoMeasurement, tmuxMeasurement] = await Promise.all([guard.measure(misao), guard.measure(tmux)]);

    expect(misaoMeasurement).toBeNull();
    expect(tmuxMeasurement?.memAvailablePercent).toBeCloseTo(50, 5);
  });
});
