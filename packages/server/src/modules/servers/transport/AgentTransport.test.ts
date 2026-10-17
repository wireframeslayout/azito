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
    const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv');
    await transport.execMux({ kind: 'tmux', args: ['list-sessions'] });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://10.0.0.1:4021/api/mux');
    const body = JSON.parse(opts!.body as string);
    expect(body).toEqual({ kind: 'tmux', args: ['list-sessions'], mux: 'system' });
  });

  it('sends managed mux runtime when configured', async () => {
    const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'managed', 'srv');
    await transport.execMux({ kind: 'tmux', args: ['list-windows'] });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.mux).toBe('managed');
  });

  it('matchesMuxRuntime returns true for same runtime', () => {
    const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv');
    expect(transport.matchesMuxRuntime('system')).toBe(true);
    expect(transport.matchesMuxRuntime('managed')).toBe(false);
  });

  it('puts a release file with the token and reports what the agent received', async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ name: 'misao.mjs', size: 3, sha256: 'abc' }), { status: 200 }));
    const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv');
    expect(await transport.uploadMisaoFile('0.2.0', 'misao.mjs', Buffer.from('xyz'))).toEqual({ name: 'misao.mjs', size: 3, sha256: 'abc' });

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://10.0.0.1:4021/api/misao/upload?version=0.2.0&name=misao.mjs');
    expect(opts).toMatchObject({ method: 'PUT', headers: { authorization: 'Bearer tok', 'content-type': 'application/octet-stream' } });
  });

  it('fails the upload with the agent\'s answer when it is refused', async () => {
    fetchSpy.mockImplementation(async () => new Response('{"error":"name must be one of"}', { status: 400 }));
    const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv');
    await expect(transport.uploadMisaoFile('0.2.0', 'misao.mjs', Buffer.from('x'))).rejects.toThrow(/failed \(400\)/);
  });

  it('reads the misao status with the token', async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ socketPath: '/s', socketPresent: false }), { status: 200 }));
    const transport = new AgentTransport('10.0.0.1', 4021, 'tok', 'system', 'srv');
    expect(await transport.fetchMisaoStatus()).toEqual({ socketPath: '/s', socketPresent: false });
    expect(fetchSpy.mock.calls[0][0]).toBe('http://10.0.0.1:4021/api/misao/status');
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ headers: { authorization: 'Bearer tok' } });
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
    const transport = new AgentTransport('127.0.0.1', port, 'tok', 'system', 'srv');
    const duplex = await transport.connectMisaoRelay(new AbortController().signal);
    const answer = new Promise<string>((resolve) => duplex.once('data', (chunk: Buffer) => resolve(chunk.toString())));
    duplex.write('ping');
    expect(await answer).toBe('echo:ping');
    // The only thing the hub names is the relay mode: where it goes is the agent's decision.
    expect(seen).toEqual([{ url: '/ws?mode=misao', authorization: 'Bearer tok' }]);
    duplex.destroy();
  });

  it('rejects when the relay cannot be opened', async () => {
    const transport = new AgentTransport('127.0.0.1', 1, 'tok', 'system', 'srv');
    await expect(transport.connectMisaoRelay(new AbortController().signal)).rejects.toThrow();
  });

  it('rejects at once for an attempt that was already aborted, and closes a socket whose attempt is aborted while connecting', async () => {
    await listen();
    const transport = new AgentTransport('127.0.0.1', port, 'tok', 'system', 'srv');
    const aborted = new AbortController();
    aborted.abort();
    await expect(transport.connectMisaoRelay(aborted.signal)).rejects.toThrow('aborted');

    const controller = new AbortController();
    const attempt = transport.connectMisaoRelay(controller.signal);
    controller.abort();
    await expect(attempt).rejects.toThrow('aborted');
  });
});
