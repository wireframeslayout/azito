import { describe, expect, it, vi } from 'vitest';
import { WindowSnapshotService } from './WindowSnapshotService';
import type { IWindowRepository } from './Window';
import type { IServerRepository } from '../servers/Server';
import type { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import { AgentUnreachableError } from '../servers/transport/AgentUnreachableError';

function setup() {
  const windows = { findById: (id: number) => id === 99 ? null : { id, serverName: id === 98 ? 'missing' : 'srv', tmuxTarget: 's:w' } };
  const servers = { findByName: (name: string) => name === 'missing' ? null : { name, defaultMux: 'tmux' } };
  const driver = { windowActivity: vi.fn().mockResolvedValue(10), resolvePane: vi.fn().mockResolvedValue('%1'), captureScreen: vi.fn().mockResolvedValue({ stdout: 'hello\n\n', stderr: '', code: 0 }) };
  const drivers = { availabilityFor: () => ({ available: true }), resolveKind: () => driver };
  return { service: new WindowSnapshotService(windows as unknown as IWindowRepository, servers as unknown as IServerRepository, drivers as unknown as MuxDriverRegistry), driver };
}
describe('WindowSnapshotService', () => {
  it('preserves order, isolates missing rows and avoids unchanged captures', async () => {
    const { service, driver } = setup();
    expect(await service.capture([99, 1, 98, 2], 12, new Map([[1, 10]]))).toEqual([
      expect.objectContaining({ id: 99, code: 'window_not_found' }),
      { id: 1, status: 'unchanged', activity: 10 },
      expect.objectContaining({ id: 98, code: 'server_not_found' }),
      { id: 2, status: 'ok', content: 'hello', activity: 10, changed: true },
    ]);
    expect(driver.captureScreen).toHaveBeenCalledTimes(1);
    expect(driver.captureScreen).toHaveBeenCalledWith(expect.anything(), '%1', -36);
  });
  it('captures null activity and limits each server to four concurrent requests', async () => {
    const { service, driver } = setup();
    let active = 0, peak = 0;
    driver.windowActivity.mockResolvedValue(null);
    driver.captureScreen.mockImplementation(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return { stdout: 'value', stderr: '', code: 0 };
    });
    const result = await service.capture([1, 2, 3, 4, 5, 6], 12, new Map([[1, 10]]));
    expect(peak).toBe(4);
    expect(result).toHaveLength(6);
    expect(result.every((item) => item.status === 'ok')).toBe(true);
  });
  it('isolates agent and failed capture errors', async () => {
    const { service, driver } = setup();
    driver.resolvePane.mockRejectedValueOnce(new AgentUnreachableError('srv', 'circuit_open'));
    driver.captureScreen.mockResolvedValueOnce({ stdout: 'secret', stderr: 'secret', code: 1 });
    const result = await service.capture([1, 2], 12);
    expect(result).toEqual([expect.objectContaining({ id: 1, code: 'capture_failed', message: expect.stringContaining('srv') }), expect.objectContaining({ id: 2, code: 'capture_failed' })]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
