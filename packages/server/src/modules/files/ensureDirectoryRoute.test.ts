import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { fileBrowseRoutes, type FileBrowseRouteOptions } from './routes';

// Issue #87 review, Important finding 1: the project wizard's "existing
// directory" mode showed "このパスを作成します" for a path discovery found
// missing, but never actually created it. `POST /api/servers/:name/directories`
// is the server-side endpoint that makes that real — this covers the route
// wiring (absolute-path validation, 404 for unknown server, delegation to
// FileBrowseService.ensureDirectory). FileBrowseService.ensureDirectory
// itself is covered directly in FileBrowseService.test.ts.
function makeOpts(overrides: Partial<FileBrowseRouteOptions> = {}): FileBrowseRouteOptions {
  return {
    serverRepo: {
      findAll: vi.fn(() => []),
      findByName: vi.fn((name: string) => (name === 'local'
        ? { name: 'local', type: 'local' as const, host: null, agentPort: null, agentToken: null, agentVersion: null,
            sshHost: null, muxRuntime: 'system' as const, sshHostFingerprint: null,
            isolationIntent: false, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '' }
        : undefined)),
      create: vi.fn(), update: vi.fn(), updateAgentVersion: vi.fn(), updateFingerprint: vi.fn(),
      clearFingerprint: vi.fn(), updateIsolationIntent: vi.fn(), delete: vi.fn(),
    } as unknown as FileBrowseRouteOptions['serverRepo'],
    tmux: {} as unknown as FileBrowseRouteOptions['tmux'],
    projectServerRepo: { find: vi.fn(() => null), findByProject: vi.fn(() => []), findByServer: vi.fn(() => []), upsert: vi.fn(), remove: vi.fn() } as unknown as FileBrowseRouteOptions['projectServerRepo'],
    transportFactory: { getTransport: vi.fn() } as unknown as FileBrowseRouteOptions['transportFactory'],
    searchService: {} as unknown as FileBrowseRouteOptions['searchService'],
    ...overrides,
  };
}

describe('POST /api/servers/:name/directories', () => {
  it('404s for an unknown server', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(fileBrowseRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/servers/ghost/directories', payload: { path: '/tmp/x' } });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a missing path', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(fileBrowseRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/servers/local/directories', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a relative path', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(fileBrowseRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/servers/local/directories', payload: { path: 'relative/dir' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/absolute/);
  });

  it('creates the directory on the local filesystem for an absolute path', async () => {
    const os = await import('os');
    const path = await import('path');
    const fs = await import('fs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-ensure-dir-'));
    const target = path.join(tmpDir, 'new', 'nested');

    const opts = makeOpts();
    const app = Fastify();
    await app.register(fileBrowseRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/servers/local/directories', payload: { path: target } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, created: true });
    expect(fs.statSync(target).isDirectory()).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is idempotent: does not fail when the directory already exists', async () => {
    const os = await import('os');
    const path = await import('path');
    const fs = await import('fs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-ensure-dir-'));

    const opts = makeOpts();
    const app = Fastify();
    await app.register(fileBrowseRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/servers/local/directories', payload: { path: tmpDir } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, created: false });

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 409 when the path exists but is not a directory', async () => {
    const os = await import('os');
    const path = await import('path');
    const fs = await import('fs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-ensure-dir-'));
    const filePath = path.join(tmpDir, 'afile.txt');
    fs.writeFileSync(filePath, 'x');

    const opts = makeOpts();
    const app = Fastify();
    await app.register(fileBrowseRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/servers/local/directories', payload: { path: filePath } });
    expect(res.statusCode).toBe(409);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
