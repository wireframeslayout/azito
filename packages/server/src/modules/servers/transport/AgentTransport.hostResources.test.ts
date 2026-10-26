import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTransport } from './AgentTransport';
import { AgentResourcesOutdatedError } from '../../../shared/os/hostResources';

const SAMPLE = { memTotalBytes: 16_000, memAvailableBytes: 8_000, disk: null };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('AgentTransport.measureHostResources', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const make = () => new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', { platform: 'win32', arch: 'x64' });

  it('reads GET /api/host/resources with the token', async () => {
    fetchSpy.mockResolvedValue(json(SAMPLE));
    expect(await make().measureHostResources()).toEqual(SAMPLE);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://10.0.0.1:4021/api/host/resources');
    expect(init).toMatchObject({ method: 'GET', headers: { authorization: 'Bearer tok' } });
  });

  it('an agent without the endpoint (404) is agent_outdated', async () => {
    fetchSpy.mockResolvedValue(json({ error: 'not found' }, 404));
    await expect(make().measureHostResources()).rejects.toBeInstanceOf(AgentResourcesOutdatedError);
  });

  it('does not turn a failing endpoint into outdated, and refuses a body of another shape', async () => {
    fetchSpy.mockResolvedValue(json({ error: 'boom' }, 500));
    await expect(make().measureHostResources()).rejects.toThrow(/failed \(500\)/);
    fetchSpy.mockResolvedValue(json({ memTotalBytes: 1 }));
    await expect(make().measureHostResources()).rejects.toThrow();
  });
});
