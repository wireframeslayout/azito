import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTransport } from './AgentTransport';

const ENTRY = { pid: 10, ppid: 1, startMs: 1_700_000_000_000, executable: null, commandLine: 'claude', rssBytes: 1024 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('AgentTransport.listProcesses', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const make = (platform: 'linux' | 'win32' = 'linux') => new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', { platform, arch: 'x64' });

  it('reads GET /api/processes with the token from an agent that has it', async () => {
    fetchSpy.mockResolvedValue(json([ENTRY]));
    expect(await make('win32').listProcesses()).toEqual([ENTRY]);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://10.0.0.1:4021/api/processes');
    expect(init).toMatchObject({ method: 'GET', headers: { authorization: 'Bearer tok' } });
  });

  it('rejects a body of another shape', async () => {
    fetchSpy.mockResolvedValue(json([{ pid: 1 }]));
    await expect(make().listProcesses()).rejects.toThrow();
  });

  it('does not turn a failing endpoint into another route', async () => {
    fetchSpy.mockResolvedValue(json({ error: 'boom' }, 500));
    await expect(make().listProcesses()).rejects.toThrow(/\/api\/processes failed \(500\)/);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('takes the list through /api/run when the agent is older than the endpoint (404)', async () => {
    fetchSpy
      .mockResolvedValueOnce(json({ error: 'not found' }, 404))
      .mockResolvedValueOnce(json({ outcome: 'result', exitCode: 0, signal: null, stdout: '5 1 00:03 64 bash\n', stderr: '' }));
    const list = await make().listProcesses();

    expect(list).toMatchObject([{ pid: 5, ppid: 1, commandLine: 'bash' }]);
    expect(String(fetchSpy.mock.calls[1][0])).toBe('http://10.0.0.1:4021/api/run');
    expect(JSON.parse(fetchSpy.mock.calls[1][1]!.body as string)).toMatchObject({ file: 'ps' });
  });

  it('remembers the 404: the second listing goes straight to /api/run', async () => {
    fetchSpy
      .mockResolvedValueOnce(json({ error: 'not found' }, 404))
      .mockImplementation(async () => json({ outcome: 'result', exitCode: 0, signal: null, stdout: '5 1 00:03 64 bash\n', stderr: '' }));
    const transport = make();
    await transport.listProcesses();
    await transport.listProcesses();

    expect(fetchSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
      'http://10.0.0.1:4021/api/processes',
      'http://10.0.0.1:4021/api/run',
      'http://10.0.0.1:4021/api/run',
    ]);
  });

  it('passes the deadline of the caller to the spec it runs', async () => {
    fetchSpy.mockResolvedValue(json({ outcome: 'result', exitCode: 0, signal: null, stdout: '', stderr: '' }));
    await new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', null).listProcesses({ timeoutMs: 5000 }).catch(() => undefined);
    // An unrecorded agent runs ps through its shell route; the deadline reaches it.
    expect(JSON.parse(fetchSpy.mock.calls[0][1]!.body as string)).toMatchObject({ timeoutMs: 5000 });
  });

  it('takes the list of an agent registered before its host was recorded through its shell route (a Unix one)', async () => {
    fetchSpy.mockResolvedValue(json({ stdout: '5 1 00:03 64 bash\n', stderr: '', code: 0 }));
    const list = await new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', null).listProcesses();

    expect(list).toMatchObject([{ pid: 5, commandLine: 'bash' }]);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0][0])).toBe('http://10.0.0.1:4021/api/exec');
  });
});
