import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { AddressInfo } from 'net';
import * as fs from 'fs';
import type { WebSocket } from 'ws';
import { AgentTransport } from './AgentTransport';
import { AgentPaneStream } from './AgentPaneStream';
import paneStreamRoutes from '../../../agent/paneStreamRoutes';
import { ManagedStreamFiles } from '../../files/ws/ManagedStreamFiles';
import { handleFileTail } from '../../files/ws/fileTailHandler';

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// The agent is an unrecorded one here (a Unix agent), so the hub names its pipe files under /tmp, which is a POSIX path.
describe.skipIf(process.platform === 'win32')('AgentPaneStream against an agent that manages its stream files', () => {
  let app: FastifyInstance | undefined;
  let stream: AgentPaneStream | undefined;

  afterEach(async () => {
    stream?.stop();
    stream = undefined;
    await app?.close();
    app = undefined;
  });

  async function startAgent(withRoutes: boolean): Promise<{ transport: AgentTransport; managed: ManagedStreamFiles }> {
    const managed = new ManagedStreamFiles(process.platform, ['/tmp']);
    app = Fastify();
    await app.register(websocket);
    if (withRoutes) await app.register(paneStreamRoutes, { managed });
    await app.register(async (f) => {
      f.get('/ws', { websocket: true }, (socket: WebSocket, request) => {
        const url = new URL(request.url, 'http://localhost');
        handleFileTail(socket, url.searchParams.get('path') ?? '', managed);
      });
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    return { transport: new AgentTransport('127.0.0.1', port, 'tok', 'system', 'srv', null), managed };
  }

  it('registers its file, streams what is written to it, and releases it on stop', async () => {
    const { transport, managed } = await startAgent(true);
    await transport.loadTaskTempHost();
    stream = transport.createPaneStream('p-1' as never) as AgentPaneStream;
    const received: string[] = [];
    stream.on('data', (line: string) => received.push(line));
    stream.start();

    const file = stream.getFilePath();
    await waitFor(() => managed.isManaged(file));
    expect(file).toMatch(/^\/tmp\/azito-pipe-p-1-\d+\.log$/);
    fs.appendFileSync(file, 'hello\nworld\n');
    await waitFor(() => received.join('') === 'hello\nworld\n');

    stream.stop();
    await waitFor(() => !fs.existsSync(file));
    expect(managed.isManaged(file)).toBe(false);
  });

  it('fails the registration on an agent without the endpoint (an older agent) as agent_outdated', async () => {
    const { transport } = await startAgent(false);
    await expect(transport.registerPaneStreamFile('/tmp/azito-pipe-p-2-1.log')).rejects.toThrow(/agent_outdated/);
  });

  it('reports an outdated agent once as stream_failed, without retrying, an error event or an unhandled rejection', async () => {
    const { transport } = await startAgent(false);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await transport.loadTaskTempHost();
      stream = transport.createPaneStream('p-3' as never) as AgentPaneStream;
      const failures: Error[] = [];
      let errorEvents = 0;
      stream.on('stream_failed', (err: Error) => failures.push(err));
      stream.on('error', () => { errorEvents++; });
      let registrations = 0;
      const original = transport.registerPaneStreamFile.bind(transport);
      transport.registerPaneStreamFile = async (p: string) => { registrations++; return original(p); };
      stream.start();
      await waitFor(() => failures.length === 1);
      await new Promise((r) => setTimeout(r, 1500));
      expect(failures[0].message).toMatch(/agent_outdated/);
      expect(registrations).toBe(1);
      expect(failures).toHaveLength(1);
      expect(errorEvents).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
