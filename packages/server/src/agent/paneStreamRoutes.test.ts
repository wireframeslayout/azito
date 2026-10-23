import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import paneStreamRoutes from './paneStreamRoutes';
import { ManagedStreamFiles } from '../modules/files/ws/ManagedStreamFiles';

describe('agent pane-stream routes', () => {
  let dir: string;
  let managed: ManagedStreamFiles;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-streams-'));
    managed = new ManagedStreamFiles([dir]);
    app = Fastify();
    await app.register(paneStreamRoutes, { managed });
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('registers a pipe file (creating it) and releases it (removing it)', async () => {
    const file = path.join(dir, 'azito-pipe-1-1.log');
    const created = await app.inject({ method: 'POST', url: '/api/pane-streams', payload: { path: file } });
    expect(created.statusCode).toBe(200);
    expect(fs.existsSync(file)).toBe(true);
    expect(managed.isManaged(file)).toBe(true);

    const released = await app.inject({ method: 'DELETE', url: `/api/pane-streams?path=${encodeURIComponent(file)}` });
    expect(released.statusCode).toBe(200);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('rejects a path that is not an azito pipe file in a temp folder', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/pane-streams', payload: { path: '/etc/passwd' } });
    expect(res.statusCode).toBe(400);
    const missing = await app.inject({ method: 'POST', url: '/api/pane-streams', payload: {} });
    expect(missing.statusCode).toBe(400);
  });

  it('does not remove a file that was never registered', async () => {
    const file = path.join(dir, 'azito-pipe-2-1.log');
    fs.writeFileSync(file, 'x');
    await app.inject({ method: 'DELETE', url: `/api/pane-streams?path=${encodeURIComponent(file)}` });
    expect(fs.existsSync(file)).toBe(true);
  });
});
