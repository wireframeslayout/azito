import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentTransport } from './AgentTransport';
import { AgentUnreachableError } from './AgentUnreachableError';

function fetchFailure(code: string): TypeError {
  return new TypeError('fetch failed', { cause: { code } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('AgentTransport circuit breaker', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const make = () => new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv7');

  it.each([
    ['ECONNREFUSED', 'refused'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
    ['EHOSTUNREACH', 'unreachable'],
  ])('maps %s to AgentUnreachableError(%s)', async (code, reason) => {
    fetchMock.mockRejectedValueOnce(fetchFailure(code));
    const err = await make().exec('echo').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentUnreachableError);
    expect(err).toMatchObject({ serverName: 'srv7', reason });
  });

  it('maps a TimeoutError abort to reason timeout', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    await expect(make().exec('echo')).rejects.toMatchObject({ reason: 'timeout' });
  });

  it('fails fast with circuit_open for 15s without calling fetch again', async () => {
    const t = make();
    fetchMock.mockRejectedValueOnce(fetchFailure('ECONNREFUSED'));
    await expect(t.exec('a')).rejects.toBeInstanceOf(AgentUnreachableError);
    await expect(t.exec('b')).rejects.toMatchObject({ reason: 'circuit_open' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('probes /health in the background once the window expires and closes the breaker on success', async () => {
    const t = make();
    fetchMock.mockRejectedValueOnce(fetchFailure('ECONNREFUSED'));
    await expect(t.exec('a')).rejects.toBeInstanceOf(AgentUnreachableError);

    vi.advanceTimersByTime(15_001);
    fetchMock.mockResolvedValueOnce(jsonResponse({ version: 'v' }));
    await expect(t.exec('b')).rejects.toMatchObject({ reason: 'circuit_open' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe('http://10.0.0.1:4021/health');
    await vi.advanceTimersByTimeAsync(0);

    fetchMock.mockResolvedValueOnce(jsonResponse({ stdout: 'ok', stderr: '', code: 0 }));
    await expect(t.exec('c')).resolves.toMatchObject({ stdout: 'ok' });
  });

  it('keeps the breaker open when the half-open probe fails', async () => {
    const t = make();
    fetchMock.mockRejectedValueOnce(fetchFailure('ECONNREFUSED'));
    await expect(t.exec('a')).rejects.toBeInstanceOf(AgentUnreachableError);
    vi.advanceTimersByTime(15_001);
    fetchMock.mockRejectedValueOnce(fetchFailure('ECONNREFUSED'));
    await expect(t.exec('b')).rejects.toMatchObject({ reason: 'circuit_open' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.isCircuitOpen()).toBe(true);
  });

  it('derives the HTTP deadline from the per-call timeoutMs', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockImplementation(async () => jsonResponse({ stdout: '', stderr: '', code: 0 }));
    const t = make();
    await t.exec('slow', 60_000);
    await t.exec('default');
    expect(spy).toHaveBeenNthCalledWith(1, 65_000);
    expect(spy).toHaveBeenNthCalledWith(2, 20_000);
  });

  it('does not open the breaker on a non-2xx agent response', async () => {
    const t = make();
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(t.exec('x')).rejects.toThrow('failed (500)');
    expect(t.isCircuitOpen()).toBe(false);
  });

  it('shares health results with the breaker', async () => {
    const t = make();
    fetchMock.mockRejectedValueOnce(fetchFailure('ECONNREFUSED'));
    await expect(t.fetchHealth()).rejects.toBeInstanceOf(AgentUnreachableError);
    expect(t.isCircuitOpen()).toBe(true);
    await expect(t.fetchHealth()).rejects.toMatchObject({ reason: 'circuit_open' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
