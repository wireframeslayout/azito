import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import Fastify, { type FastifyInstance } from 'fastify';
import agentRoutes from './routes';
import { agentAuthHook } from './authHook';
import { buildCommandSpec } from '../shared/exec/commandSpec';

const AUTH = { authorization: 'Bearer secret' };
const node = (script: string, options: Parameters<typeof buildCommandSpec>[2] = {}) => buildCommandSpec(process.execPath, ['-e', script], options);

describe('agent POST /api/run', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    // As in agent/main.ts: the routes are registered, then the auth hook covers them.
    await app.register(agentRoutes, {
      agentVersion: 'v', startedAt: Date.now(), agentEventBus: new EventEmitter(), browserSessionManager: {} as never,
      bindAddress: '127.0.0.1', homeDir: '/home/u', hostProfile: { platform: 'linux', arch: 'x64' },
    });
    app.addHook('onRequest', agentAuthHook((header) => header === 'Bearer secret'));
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  const post = (payload: unknown, headers: Record<string, string> = AUTH) => app.inject({ method: 'POST', url: '/api/run', payload: payload as never, headers });

  it('requires the agent token', async () => {
    const spec = node('1');
    expect((await post(spec, {})).statusCode).toBe(401);
    expect((await post(spec, { authorization: 'Bearer wrong' })).statusCode).toBe(401);
  });

  it('runs the spec and reports the result', async () => {
    const res = await post(node('process.stdout.write("hi"); process.stderr.write("e"); process.exit(4)'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: 'result', exitCode: 4, signal: null, stdout: 'hi', stderr: 'e' });
  });

  it('reports a program that cannot start in the body, not as an HTTP error', async () => {
    const res = await post(buildCommandSpec('azito-no-such-program-xyz', []));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'spawn_failed', code: 'ENOENT' });
  });

  it('reports a timeout with the output so far', async () => {
    const res = await post(node('process.stdout.write("p"); setInterval(()=>{},1000)', { timeoutMs: 400 }));
    expect(res.json()).toMatchObject({ outcome: 'timeout', stdout: 'p' });
  });

  it('reports an output-limit overrun', async () => {
    const res = await post(node('process.stdout.write("x".repeat(50000)); setInterval(()=>{},1000)', { maxOutputBytes: 100, timeoutMs: 10_000 }));
    expect(res.json()).toMatchObject({ outcome: 'output_limit', maxOutputBytes: 100 });
  });

  it.each([
    ['an env name with "="', 'A=B'],
    ['an env name that is not an identifier', 'A;rm -rf /'],
    ['an empty env name', ''],
    ['an env name with a NUL', 'A\u0000B'],
    ['an env name starting with a digit', '1A'],
  ])('answers 400 for %s, as the shell route of an older agent would refuse it', async (_label, name) => {
    const res = await post({ file: 'git', args: [], env: { [name]: 'v' }, timeoutMs: 1000, maxOutputBytes: 1000 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_command_spec' });
  });

  it('accepts an env name that is an identifier', async () => {
    const res = await post(node('process.stdout.write(process.env.AZITO_ENV_OK ?? "")', { env: { AZITO_ENV_OK: 'yes' } }));
    expect(res.json()).toMatchObject({ outcome: 'result', stdout: 'yes' });
  });

  it.each([
    ['no body', undefined],
    ['a string for args', { file: 'git', args: 'status', timeoutMs: 1000, maxOutputBytes: 1000 }],
    ['an empty file', { file: '', args: [], timeoutMs: 1000, maxOutputBytes: 1000 }],
    ['no timeout', { file: 'git', args: [], maxOutputBytes: 1000 }],
    ['a timeout past the cap', { file: 'git', args: [], timeoutMs: 99_999_999, maxOutputBytes: 1000 }],
    ['a NUL in an argument', { file: 'git', args: ['a\u0000b'], timeoutMs: 1000, maxOutputBytes: 1000 }],
  ])('answers 400 for %s without running anything', async (_label, payload) => {
    const res = await post(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_command_spec' });
  });
});
