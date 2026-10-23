import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Fastify, { type FastifyInstance } from 'fastify';
import misaoRoutes from './misaoRoutes';
import { misaoStagingDir } from '../modules/servers/transport/agentMisaoSocket';
import type { AgentMisaoHost } from '../modules/servers/transport/agentMisaoSocket';

describe('agent misao routes', () => {
  let home: string;
  let app: FastifyInstance;
  let host: AgentMisaoHost;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'azmr-'));
    host = { homeDir: home, nodePath: process.execPath, servicePath: '/usr/bin', platform: 'linux', arch: 'x64' };
    app = Fastify();
    await app.register(misaoRoutes, {
      socket: { path: path.join(home, '.azito', 'misao', 'misao.sock') },
      host,
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

  // Windows では動かない: mode 755 前提（Windows には POSIX の mode が無い）
  it.skipIf(process.platform === 'win32')('stages a release file under the fixed layout and reports its sha256', async () => {
    const res = await upload('version=0.3.0&name=misao', 'binary-bytes');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: 'misao', size: 12, sha256: crypto.createHash('sha256').update('binary-bytes').digest('hex') });
    const staged = path.join(misaoStagingDir(host, '0.3.0'), 'misao');
    expect(fs.readFileSync(staged, 'utf-8')).toBe('binary-bytes');
    expect(fs.statSync(staged).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(home, '.azito', 'misao')).mode & 0o777).toBe(0o700);
  });

  // Windows では動かない: mode 前提（Windows には POSIX の mode が無い）
  it.skipIf(process.platform === 'win32')('stages a license file without the execute bit', async () => {
    const res = await upload('version=0.3.0&name=NOTICE');
    expect(res.statusCode).toBe(200);
    expect(fs.statSync(path.join(misaoStagingDir(host, '0.3.0'), 'NOTICE')).mode & 0o777).toBe(0o644);
  });

  it.each([
    ['a name outside the release files', 'version=0.3.0&name=evil.sh'],
    ['the retired Node bundle', 'version=0.3.0&name=misao.mjs'],
    ['a path in the name', 'version=0.3.0&name=../../.bashrc'],
    ['a name missing', 'version=0.3.0'],
    ['a version that is not x.y.z', 'version=../../x&name=misao'],
    ['a version missing', 'name=misao'],
  ])('refuses %s and writes nothing', async (_label, query) => {
    const res = await upload(query);
    expect(res.statusCode).toBe(400);
    expect(fs.existsSync(path.join(home, '.azito'))).toBe(false);
  });

  it('refuses a body that is not application/octet-stream', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/misao/upload?version=0.3.0&name=misao', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect([400, 415]).toContain(res.statusCode);
    expect(fs.existsSync(path.join(home, '.azito'))).toBe(false);
  });
});
