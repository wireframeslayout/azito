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

// The hub names agent pipe files under /tmp for now, which is a POSIX path.
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
    const managed = new ManagedStreamFiles(['/tmp']);
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
    return { transport: new AgentTransport('127.0.0.1', port, 'tok', 'system', 'srv'), managed };
  }

  it('registers its file, streams what is written to it, and releases it on stop', async () => {
    const { transport, managed } = await startAgent(true);
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

  it('fails the registration on an agent without the endpoint (an older agent)', async () => {
    const { transport } = await startAgent(false);
    await expect(transport.registerPaneStreamFile('/tmp/azito-pipe-p-2-1.log')).rejects.toThrow(/404/);
  });
});
