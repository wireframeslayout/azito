import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Fastify, { type FastifyInstance } from 'fastify';
import misaoRoutes, { misaoStagingDir } from './misaoRoutes';

describe('agent misao routes', () => {
  let home: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'azmr-'));
    app = Fastify();
    await app.register(misaoRoutes, {
      socket: { path: path.join(home, '.azito', 'misao', 'misao.sock') },
      host: { homeDir: home, nodePath: process.execPath, servicePath: '/usr/bin', nodePtyDir: null, platform: 'linux', arch: 'x64' },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const upload = (query: string, body: Buffer | string = 'payload') => app.inject({
    method: 'PUT',
    url: `/api/misao/upload?${query}`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: body,
  });

  it('reports the socket, the host and no install on a fresh host', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/misao/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ socketPath: path.join(home, '.azito', 'misao', 'misao.sock'), socketPresent: false, host: { homeDir: home, arch: 'x64' } });
    expect(res.json()).not.toHaveProperty('installedVersion');
  });

  it('stages a release file under the fixed layout and reports its sha256', async () => {
    const res = await upload('version=0.2.0&name=misao.mjs', 'console.log(1)');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: 'misao.mjs', size: 14, sha256: crypto.createHash('sha256').update('console.log(1)').digest('hex') });
    const staged = path.join(misaoStagingDir(home, '0.2.0'), 'misao.mjs');
    expect(fs.readFileSync(staged, 'utf-8')).toBe('console.log(1)');
    expect(fs.statSync(staged).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(home, '.azito', 'misao')).mode & 0o777).toBe(0o700);
  });

  it('stages the licenses file without the execute bit', async () => {
    const res = await upload('version=0.2.0&name=LICENSES.txt');
    expect(res.statusCode).toBe(200);
    expect(fs.statSync(path.join(misaoStagingDir(home, '0.2.0'), 'LICENSES.txt')).mode & 0o777).toBe(0o644);
  });

  it.each([
    ['a name outside the release files', 'version=0.2.0&name=evil.sh'],
    ['a path in the name', 'version=0.2.0&name=../../.bashrc'],
    ['a name missing', 'version=0.2.0'],
    ['a version that is not x.y.z', 'version=../../x&name=misao.mjs'],
    ['a version missing', 'name=misao.mjs'],
  ])('refuses %s and writes nothing', async (_label, query) => {
    const res = await upload(query);
    expect(res.statusCode).toBe(400);
    expect(fs.existsSync(path.join(home, '.azito'))).toBe(false);
  });

  it('refuses a body that is not application/octet-stream', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/misao/upload?version=0.2.0&name=misao.mjs', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect([400, 415]).toContain(res.statusCode);
    expect(fs.existsSync(path.join(home, '.azito'))).toBe(false);
  });
});
