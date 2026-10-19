import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import fileOpsRoutes from './fileOpsRoutes';
import { agentAuthHook } from './authHook';
import { LocalFileOps, localFileOpsHostFromEnv } from '../shared/fs/LocalFileOps';

const AUTH = { authorization: 'Bearer secret' };

describe('agent POST /api/fileops', () => {
  let app: FastifyInstance;
  let dir: string;

  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'azito-agent-fileops-')));
    app = Fastify();
    // As in agent/main.ts: the routes are registered, then the auth hook covers them.
    await app.register(fileOpsRoutes, { ops: new LocalFileOps(localFileOpsHostFromEnv({ platform: process.platform, homeDir: dir, tmpDir: dir }, process.env)) });
    app.addHook('onRequest', agentAuthHook((header) => header === 'Bearer secret'));
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (payload: unknown, headers: Record<string, string> = AUTH) => app.inject({ method: 'POST', url: '/api/fileops', payload: payload as never, headers });

  it('requires the agent token', async () => {
    expect((await post({ op: 'list', path: dir }, {})).statusCode).toBe(401);
    expect((await post({ op: 'list', path: dir }, { authorization: 'Bearer wrong' })).statusCode).toBe(401);
  });

  it('performs the operation on the agent\'s files and reports the result', async () => {
    writeFileSync(path.join(dir, 'a.txt'), 'hello');
    const res = await post({ op: 'list', path: dir });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, result: [{ name: 'a.txt', kind: 'file', size: 5 }] });
  });

  it('writes a file atomically and reports the new mtime and hash', async () => {
    const res = await post({ op: 'write', path: path.join(dir, 'w.txt'), dataBase64: Buffer.from('data').toString('base64') });
    expect(res.json()).toMatchObject({ ok: true, result: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(readFileSync(path.join(dir, 'w.txt'), 'utf8')).toBe('data');
  });

  it('reports a refusal in the body, not as an HTTP error', async () => {
    const res = await post({ op: 'read', path: path.join(dir, 'missing') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('answers a malformed request with 400 and does nothing', async () => {
    expect((await post({ op: 'remove' })).statusCode).toBe(400);
    expect((await post({ op: 'format-disk', path: dir })).statusCode).toBe(400);
    expect((await post([])).statusCode).toBe(400);
  });

  it('refuses a path with a NUL byte through the same checks the hub\'s own files get', async () => {
    const res = await post({ op: 'stat', path: `${dir}\0x` });
    expect(res.json()).toMatchObject({ ok: false, code: 'INVALID_PATH' });
  });
});
