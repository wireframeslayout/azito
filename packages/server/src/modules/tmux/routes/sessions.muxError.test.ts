import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sessionsRoutes, { type SessionsRouteOptions } from './sessions';
import type { IServerRepository, ServerConfig } from '../../servers/Server';
import type { TmuxClient } from '../TmuxClient';
import type { SqliteWindowRepository } from '../../windows/SqliteWindowRepository';
import { KeyedMutex } from '../../../shared/keyedMutex';
import type { IMuxClient } from '../IMuxClient';
import type { MuxDriverRegistry } from '../MuxDriverRegistry';

const srv: ServerConfig = { name: 'srv1', type: 'local', defaultMux: 'tmux', isolationIntent: false } as ServerConfig;
const paneHandle = '%0';

function makeServerRepo(): IServerRepository {
  return { findByName: (name: string) => (name === srv.name ? srv : undefined) } as unknown as IServerRepository;
}

function makeWindowRepo(): SqliteWindowRepository {
  return {
    removeByServerAndTarget: vi.fn(() => 0),
    remove: vi.fn(),
    findByServerAndTarget: vi.fn(() => undefined),
    findByServerAndRef: vi.fn(() => undefined),
    findByServerAndSession: vi.fn(() => []),
    now: vi.fn(() => '2026-01-01 00:00:00'),
  } as unknown as SqliteWindowRepository;
}

async function buildApp(muxOverrides: Partial<IMuxClient>, windowRepo = makeWindowRepo(), tmux = {} as TmuxClient): Promise<FastifyInstance> {
  const baseMux = {
    kind: 'tmux',
    caps: { zoom: true, paneTitle: true, paneLabels: false, outputStream: true },
    supportsPaneLabels: false,
    resolvePane: vi.fn(async () => paneHandle),
    ...muxOverrides,
  } as unknown as IMuxClient;
  const registry = { resolve: vi.fn(() => baseMux), availabilityFor: vi.fn(() => ({ available: true })) } as unknown as MuxDriverRegistry;
  const app = Fastify();
  await app.register(sessionsRoutes, {
    serverRepo: makeServerRepo(),
    tmux,
    uiToken: 'test-token',
    windowRepo,
    buildSecondaryWindowEnv: () => ({}),
    resourceGuard: undefined as unknown as SessionsRouteOptions['resourceGuard'],
    serverIsolationMutex: new KeyedMutex(),
    muxDriverRegistry: registry,
  });
  await app.ready();
  return app;
}

const encodedRef = encodeURIComponent(JSON.stringify({ kind: 'tmux', workspace: 'main', window: '1' }));

describe('PUT /api/servers/:name/mux/windows/:ref/rename error handling', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app.close(); });

  it('updates the registered label only after a successful rename', async () => {
    const repo = makeWindowRepo();
    repo.findByServerAndRef = vi.fn(() => ({ id: 4 }) as never);
    repo.update = vi.fn();
    app = await buildApp({ renameWindowByRef: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })) }, repo);
    const res = await app.inject({ method: 'PUT', url: `/api/servers/srv1/mux/windows/${encodedRef}/rename`, payload: { name: 'chosen' } });
    expect(res.statusCode).toBe(200);
    expect(repo.update).toHaveBeenCalledWith(4, { label: 'chosen', labelSource: 'user' });
  });

  it('reports a database failure after the mux rename', async () => {
    const repo = makeWindowRepo();
    repo.findByServerAndRef = vi.fn(() => ({ id: 4 }) as never);
    repo.update = vi.fn(() => { throw new Error('database failure'); });
    app = await buildApp({ renameWindowByRef: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })) }, repo);
    const res = await app.inject({ method: 'PUT', url: `/api/servers/srv1/mux/windows/${encodedRef}/rename`, payload: { name: 'chosen' } });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/renamed.*saving/);
  });

  it('returns 404 when rename fails with "not found"', async () => {
    app = await buildApp({ renameWindowByRef: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'window not found' })) });
    const res = await app.inject({ method: 'PUT', url: `/api/servers/srv1/mux/windows/${encodedRef}/rename`, payload: { name: 'new' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'window not found' });
  });

  it('returns 500 when rename fails with a generic error', async () => {
    app = await buildApp({ renameWindowByRef: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'some error' })) });
    const res = await app.inject({ method: 'PUT', url: `/api/servers/srv1/mux/windows/${encodedRef}/rename`, payload: { name: 'new' } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'some error' });
  });
});

describe('POST .../zoom error handling', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app.close(); });

  it('returns 500 when zoom fails', async () => {
    app = await buildApp({ zoomPaneByHandle: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'zoom error' })) });
    const res = await app.inject({ method: 'POST', url: `/api/servers/srv1/mux/windows/${encodedRef}/panes/1/zoom` });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'zoom error' });
  });

  it('returns 404 when zoom fails with "no such"', async () => {
    app = await buildApp({ zoomPaneByHandle: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'no such pane' })) });
    const res = await app.inject({ method: 'POST', url: `/api/servers/srv1/mux/windows/${encodedRef}/panes/1/zoom` });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST .../unzoom error handling', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app.close(); });

  it('returns 500 when unzoom fails', async () => {
    app = await buildApp({ unzoomPaneByHandle: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'unzoom error' })) });
    const res = await app.inject({ method: 'POST', url: `/api/servers/srv1/mux/windows/${encodedRef}/panes/1/unzoom` });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'unzoom error' });
  });
});

describe('PUT .../panes/:ordinal/rename error handling', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app.close(); });

  it('returns 404 when setPaneTitle fails with "does not exist"', async () => {
    app = await buildApp({ setPaneTitle: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'pane does not exist' })) });
    const res = await app.inject({ method: 'PUT', url: `/api/servers/srv1/mux/windows/${encodedRef}/panes/1/rename`, payload: { name: 'title' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'pane does not exist' });
  });

  it('returns 500 when setPaneTitle fails with a generic error', async () => {
    app = await buildApp({ setPaneTitle: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'internal' })) });
    const res = await app.inject({ method: 'PUT', url: `/api/servers/srv1/mux/windows/${encodedRef}/panes/1/rename`, payload: { name: 'title' } });
    expect(res.statusCode).toBe(500);
  });
});


describe('legacy window rename', () => {
  it.each([0, 1])('updates the label only when tmux returns %i', async (code) => {
    const repo = makeWindowRepo();
    repo.findByServerAndTarget = vi.fn(() => ({ id: 4 }) as never);
    repo.update = vi.fn();
    const tmux = { renameWindow: vi.fn(async () => ({ code, stdout: '', stderr: 'failure' })) } as unknown as TmuxClient;
    const app = await buildApp({}, repo, tmux);
    const res = await app.inject({ method: 'PUT', url: '/api/servers/srv1/windows/main%3A1/rename', payload: { name: 'chosen' } });
    expect(res.statusCode).toBe(code === 0 ? 200 : 500);
    if (code === 0) expect(repo.update).toHaveBeenCalledWith(4, { label: 'chosen', labelSource: 'user' });
    else expect(repo.update).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('window creation failures', () => {
  it.each(['result', 'exception'])('does not expose remote %s details', async (failure) => {
    const openWindow = vi.fn(async () => {
      if (failure === 'exception') throw new Error('Command failed: tmux -e TOKEN=secret');
      return { result: { code: 1, stdout: 'TOKEN=secret', stderr: 'TOKEN=secret' }, ref: {}, windowName: 'w' };
    });
    const app = await buildApp({ openWindow } as Partial<IMuxClient>);
    const res = await app.inject({ method: 'POST', url: '/api/servers/srv1/mux/workspaces/missing/windows', payload: {} });
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain('create window failed');
    expect(res.body).not.toContain('secret');
    await app.close();
  });
});

it.skipIf(process.platform === 'win32')('does not expose pane tokens when local tmux cannot create a window', async () => {
  const { LocalTransport } = await import('../../servers/transport/LocalTransport');
  const { TmuxClient } = await import('../TmuxClient');
  const { TaskTempFiles } = await import('../../../shared/os/taskTempFiles');
  const { testLocalHost } = await import('../../../shared/os/testing/testLocalHost');
  const socket = `azito-test-${process.pid}-${Date.now()}`;
  const transport = new LocalTransport({ bin: 'tmux', baseArgs: ['-L', socket] }, 'http://hub', testLocalHost(), new TaskTempFiles('/tmp', 'linux'), { platform: 'linux', arch: 'x64' });
  const tmux = new TmuxClient({ getTransport: () => transport } as never, 'http://hub', 'ui-token-test-123', 'http://localhost', 'webhook-token-test-456', '/tmp');
  const app = await buildApp({}, makeWindowRepo(), tmux);
  const response = await app.inject({ method: 'POST', url: '/api/servers/srv1/sessions/missing/windows', payload: {} });
  expect(response.statusCode).toBe(500);
  expect(response.body).toContain('new-window failed');
  expect(response.body).not.toContain('ui-token-test-123');
  expect(response.body).not.toContain('webhook-token-test-456');
  expect(response.body).not.toContain('-e');
  await app.close();
});
