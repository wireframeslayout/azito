import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import Fastify, { type FastifyInstance } from 'fastify';
import agentRoutes from './routes';
import type { HostProfile } from '../shared/os/hostProfile';

async function build(hostProfile: HostProfile): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(agentRoutes, {
    agentVersion: 'v', startedAt: Date.now(), agentEventBus: new EventEmitter(), browserSessionManager: {} as never,
    bindAddress: '127.0.0.1', homeDir: '/home/u', hostProfile,
  });
  await app.ready();
  return app;
}

describe('agent POST /api/exec and the agent host', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it.skipIf(process.platform === 'win32')('runs the command with sh on a Unix agent', async () => {
    app = await build({ platform: 'linux', arch: 'x64' });
    const res = await app.inject({ method: 'POST', url: '/api/exec', payload: { command: 'echo hi' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stdout: 'hi\n', code: 0 });
  });

  it('answers 501 unsupported_os on a Windows agent instead of trying to spawn /bin/sh', async () => {
    app = await build({ platform: 'win32', arch: 'x64' });
    const res = await app.inject({ method: 'POST', url: '/api/exec', payload: { command: 'echo hi' } });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ error: 'unsupported_os', message: expect.stringContaining('/bin/sh') });
  });
});
