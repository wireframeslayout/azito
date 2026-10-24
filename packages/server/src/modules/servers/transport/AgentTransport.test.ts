import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import { WebSocketServer } from 'ws';
import { AgentTransport } from './AgentTransport';

describe('AgentTransport', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (
      new Response(JSON.stringify({ stdout: '', stderr: '', code: 0 }), { status: 200 })
    ));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends mux field in /api/mux POST for tmux requests', async () => {
    const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', null);
    await transport.execMux({ kind: 'tmux', args: ['list-sessions'] });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://10.0.0.1:4021/api/mux');
    const body = JSON.parse(opts!.body as string);
    expect(body).toEqual({ kind: 'tmux', args: ['list-sessions'], mux: 'system' });
  });

  it('sends managed mux runtime when configured', async () => {
    const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'managed', 'srv', null);
    await transport.execMux({ kind: 'tmux', args: ['list-windows'] });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.mux).toBe('managed');
  });

  it('matchesMuxRuntime returns true for same runtime', () => {
    const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', null);
    expect(transport.matchesMuxRuntime('system')).toBe(true);
    expect(transport.matchesMuxRuntime('managed')).toBe(false);
  });

  it('puts a release file with the token and reports what the agent received', async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ name: 'misao', size: 3, sha256: 'abc' }), { status: 200 }));
    const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', null);
    expect(await transport.uploadMisaoFile('0.3.0', 'misao', Buffer.from('xyz'))).toEqual({ name: 'misao', size: 3, sha256: 'abc' });

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://10.0.0.1:4021/api/misao/upload?version=0.3.0&name=misao');
    expect(opts).toMatchObject({ method: 'PUT', headers: { authorization: 'Bearer tok', 'content-type': 'application/octet-stream' } });
  });

  it('fails the upload with the agent\'s answer when it is refused', async () => {
    fetchSpy.mockImplementation(async () => new Response('{"error":"name must be one of"}', { status: 400 }));
    const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', null);
    await expect(transport.uploadMisaoFile('0.3.0', 'misao', Buffer.from('x'))).rejects.toThrow(/failed \(400\)/);
  });

  it('reads the misao status with the token', async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ socketPath: '/s', socketPresent: false }), { status: 200 }));
    const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', null);
    expect(await transport.fetchMisaoStatus()).toEqual({ socketPath: '/s', socketPresent: false });
    expect(fetchSpy.mock.calls[0][0]).toBe('http://10.0.0.1:4021/api/misao/status');
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ headers: { authorization: 'Bearer tok' } });
  });
});

describe('AgentTransport host profile', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (
      new Response(JSON.stringify({ stdout: 'ok', stderr: '', code: 0 }), { status: 200 })
    ));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it.each([
    ['an agent with no recorded host (a Unix agent from before Windows support)', null],
    ['a linux agent', { platform: 'linux' as const, arch: 'x64' as const }],
    ['a macOS agent', { platform: 'darwin' as const, arch: 'arm64' as const }],
  ])('keeps running sh commands on %s', async (_label, profile) => {
    const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', profile);
    expect((await transport.exec('echo ok')).stdout).toBe('ok');
    expect(fetchSpy.mock.calls[0][0]).toBe('http://10.0.0.1:4021/api/exec');
  });

  it('refuses exec(string) on a win32 agent with a reason, before anything is sent', async () => {
    const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'win1', { platform: 'win32', arch: 'x64' });
    await expect(transport.exec('echo ok')).rejects.toMatchObject({ code: 'unsupported_os', message: expect.stringContaining('agent server "win1"') });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('compares profiles by value', () => {
    const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', { platform: 'linux', arch: 'x64' });
    expect(transport.matchesHostProfile({ platform: 'linux', arch: 'x64' })).toBe(true);
    expect(transport.matchesHostProfile({ platform: 'linux', arch: 'arm64' })).toBe(false);
    expect(transport.matchesHostProfile(null)).toBe(false);
    expect(new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', null).matchesHostProfile(null)).toBe(true);
  });

  describe('fetchHostInfo', () => {
    it("reads the agent's report with the token", async () => {
      fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ platform: 'linux', arch: 'x64', shell: '/bin/bash', homeDir: '/home/u', tmpDir: '/tmp' }), { status: 200 }));
      const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', null);
      expect(await transport.fetchHostInfo()).toEqual({ platform: 'linux', arch: 'x64', shell: '/bin/bash', homeDir: '/home/u', tmpDir: '/tmp' });
      expect(fetchSpy.mock.calls[0][0]).toBe('http://10.0.0.1:4021/api/host');
      expect(fetchSpy.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { authorization: 'Bearer tok' } });
    });

    it('is agent_outdated for an agent without the endpoint (404)', async () => {
      fetchSpy.mockImplementation(async () => new Response('{"error":"Not Found"}', { status: 404 }));
      const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', null);
      await expect(transport.fetchHostInfo()).rejects.toMatchObject({ name: 'AgentHostOutdatedError', serverName: 'srv' });
    });

    it('fails on any other error status and on an answer of another shape', async () => {
      const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', null);
      fetchSpy.mockImplementation(async () => new Response('nope', { status: 401 }));
      await expect(transport.fetchHostInfo()).rejects.toThrow(/failed \(401\)/);
      fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ platform: 'linux' }), { status: 200 }));
      await expect(transport.fetchHostInfo()).rejects.toThrow();
    });
  });

  describe('task temp files (loadTaskTempHost)', () => {
    const report = (platform: string, tmpDir: string): void => {
      fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ platform, arch: 'x64', shell: null, homeDir: '/h', tmpDir }), { status: 200 }));
    };

    it('uses the OS and temp folder the agent reports, asked once', async () => {
      report('win32', 'C:\\Users\\u\\AppData\\Local\\Temp');
      const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', { platform: 'win32', arch: 'x64' });
      expect(await transport.loadTaskTempHost()).toEqual({ platform: 'win32', tmpDir: 'C:\\Users\\u\\AppData\\Local\\Temp' });
      expect(await transport.loadTaskTempHost()).toEqual({ platform: 'win32', tmpDir: 'C:\\Users\\u\\AppData\\Local\\Temp' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('names a pipe file in the notation of the agent\'s OS', async () => {
      report('win32', 'C:\\Temp');
      const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', { platform: 'win32', arch: 'x64' });
      const host = await transport.loadTaskTempHost();
      expect(transport.createPaneStream('9-1' as never, { type: 'agent', ...host }).getFilePath()).toMatch(/^C:\\Temp\\azito-pipe-9-1-\d+\.log$/);
    });

    it('is the Unix /tmp for an agent whose host was never recorded, without asking it', async () => {
      const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', null);
      expect(await transport.loadTaskTempHost()).toEqual({ platform: 'linux', tmpDir: '/tmp' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects, and remembers nothing, when the agent cannot be asked or reports a Unix folder unsafe in a shell command', async () => {
      const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', { platform: 'linux', arch: 'x64' });
      fetchSpy.mockImplementation(async () => new Response('nope', { status: 500 }));
      await expect(transport.loadTaskTempHost()).rejects.toThrow(/failed \(500\)/);
      report('linux', '/tmp/my dir');
      await expect(transport.loadTaskTempHost()).rejects.toThrow(/agent server "srv"/);
      report('linux', '/tmp');
      expect(await transport.loadTaskTempHost()).toEqual({ platform: 'linux', tmpDir: '/tmp' });
    });

    it('refuses a pane stream for a temp folder that is not an agent\'s', () => {
      const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', null);
      expect(() => transport.createPaneStream('9-1' as never, { type: 'local' })).toThrow(/needs the agent's temp folder/);
    });

    it('treats an old agent that does not report the temp folder as a Unix one with /tmp (the answer of before it was reported)', async () => {
      fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ platform: 'darwin', arch: 'arm64', shell: '/bin/zsh' }), { status: 200 }));
      const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', { platform: 'darwin', arch: 'arm64' });
      expect(await transport.fetchHostInfo()).toEqual({ platform: 'darwin', arch: 'arm64', shell: '/bin/zsh' });
      expect(await transport.loadTaskTempHost()).toEqual({ platform: 'darwin', tmpDir: '/tmp' });
    });

    it('is an error, with the reason, for a Windows agent that does not report the temp folder', async () => {
      fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ platform: 'win32', arch: 'x64', shell: null }), { status: 200 }));
      const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', { platform: 'win32', arch: 'x64' });
      await expect(transport.loadTaskTempHost()).rejects.toThrow(/did not report its temp folder/);
    });

    it('still rejects a malformed answer (a wrong type for tmpDir)', async () => {
      fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ platform: 'linux', arch: 'x64', shell: null, tmpDir: 5 }), { status: 200 }));
      const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv', { platform: 'linux', arch: 'x64' });
      await expect(transport.loadTaskTempHost()).rejects.toThrow();
    });
  });
});

describe('AgentTransport.connectMisaoRelay', () => {
  let wss: WebSocketServer | undefined;
  let port = 0;
  const seen: Array<{ url: string | undefined; authorization: string | undefined }> = [];

  async function listen(): Promise<void> {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (ws, request) => {
      seen.push({ url: request.url, authorization: request.headers.authorization });
      ws.on('message', (data) => ws.send(Buffer.concat([Buffer.from('echo:'), data as Buffer])));
    });
    await new Promise<void>((resolve) => wss!.once('listening', resolve));
    port = (wss.address() as net.AddressInfo).port;
  }

  afterEach(async () => {
    seen.length = 0;
    for (const c of wss?.clients ?? []) c.terminate();
    await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
    wss = undefined;
  });

  it('opens the agent\'s relay path with the token and gives back a duplex that carries bytes', async () => {
    await listen();
    const transport = new AgentTransport('127.0.0.1', port, 'tok', 'system', 'srv', null);
    const duplex = await transport.connectMisaoRelay(new AbortController().signal);
    const answer = new Promise<string>((resolve) => duplex.once('data', (chunk: Buffer) => resolve(chunk.toString())));
    duplex.write('ping');
    expect(await answer).toBe('echo:ping');
    // The only thing the hub names is the relay mode: where it goes is the agent's decision.
    expect(seen).toEqual([{ url: '/ws?mode=misao', authorization: 'Bearer tok' }]);
    duplex.destroy();
  });

  it('rejects when the relay cannot be opened', async () => {
    const transport = new AgentTransport('127.0.0.1', 1, 'tok', 'system', 'srv', null);
    await expect(transport.connectMisaoRelay(new AbortController().signal)).rejects.toThrow();
  });

  it('rejects at once for an attempt that was already aborted, and closes a socket whose attempt is aborted while connecting', async () => {
    await listen();
    const transport = new AgentTransport('127.0.0.1', port, 'tok', 'system', 'srv', null);
    const aborted = new AbortController();
    aborted.abort();
    await expect(transport.connectMisaoRelay(aborted.signal)).rejects.toThrow('aborted');

    const controller = new AbortController();
    const attempt = transport.connectMisaoRelay(controller.signal);
    controller.abort();
    await expect(attempt).rejects.toThrow('aborted');
  });
});
