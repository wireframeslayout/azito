import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentTransport } from './AgentTransport';

describe('AgentTransport', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ stdout: '', stderr: '', code: 0 }),
    } as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends mux field in /api/mux POST for tmux requests', async () => {
    const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system');
    await transport.execMux({ kind: 'tmux', args: ['list-sessions'] });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://10.0.0.1:4021/api/mux');
    const body = JSON.parse(opts!.body as string);
    expect(body).toEqual({ kind: 'tmux', args: ['list-sessions'], mux: 'system' });
  });

  it('sends managed mux runtime when configured', async () => {
    const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'managed');
    await transport.execMux({ kind: 'tmux', args: ['list-windows'] });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.mux).toBe('managed');
  });

  it('does not add mux field for herdr requests', async () => {
    const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'herdr');
    await transport.execMux({ kind: 'herdr', method: 'list_windows', params: {} });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body).toEqual({ kind: 'herdr', method: 'list_windows', params: {} });
    expect(body.mux).toBeUndefined();
  });

  it('matchesMuxRuntime returns true for same runtime', () => {
    const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system');
    expect(transport.matchesMuxRuntime('system')).toBe(true);
    expect(transport.matchesMuxRuntime('herdr')).toBe(false);
  });
});
