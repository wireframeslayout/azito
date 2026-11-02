import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
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

const emit = vi.fn();

async function buildApp(muxOverrides: Partial<IMuxClient>, windowRepo = makeWindowRepo(), tmux = {} as TmuxClient): Promise<FastifyInstance> {
  const baseMux = {
    kind: 'tmux',
    caps: { zoom: true, paneTitle: true, paneLabels: false, outputStream: true },
    supportsPaneLabels: false,
    resolvePane: vi.fn(async () => paneHandle),
    ...muxOverrides,
  } as unknown as IMuxClient;
  const registry = { resolve: vi.fn(() => baseMux) } as unknown as MuxDriverRegistry;
  const app = Fastify();
  await app.register(sessionsRoutes, {
    notificationBus: { emit } as never,
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
  beforeEach(() => emit.mockClear());
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
    expect(emit).toHaveBeenCalledWith({ type: 'window:renamed', payload: { serverName: 'srv1', target: 'main:1', newName: 'chosen', windowId: 4 } });
  });

  it('emits the old target for an unregistered window', async () => {
    app = await buildApp({ renameWindowByRef: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })) });
    const res = await app.inject({ method: 'PUT', url: `/api/servers/srv1/mux/windows/${encodedRef}/rename`, payload: { name: 'chosen' } });
    expect(res.statusCode).toBe(200);
    expect(emit).toHaveBeenCalledWith({ type: 'window:renamed', payload: { serverName: 'srv1', target: 'main:1', newName: 'chosen', windowId: undefined } });
  });

  it('reports a database failure after the mux rename', async () => {
    const repo = makeWindowRepo();
    repo.findByServerAndRef = vi.fn(() => ({ id: 4 }) as never);
    repo.update = vi.fn(() => { throw new Error('database failure'); });
    app = await buildApp({ renameWindowByRef: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })) }, repo);
    const res = await app.inject({ method: 'PUT', url: `/api/servers/srv1/mux/windows/${encodedRef}/rename`, payload: { name: 'chosen' } });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/renamed.*saving/);
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'window:renamed' }));
  });

  it('returns 404 when rename fails with "not found"', async () => {
    app = await buildApp({ renameWindowByRef: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'window not found' })) });
    const res = await app.inject({ method: 'PUT', url: `/api/servers/srv1/mux/windows/${encodedRef}/rename`, payload: { name: 'new' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'window not found' });
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'window:renamed' }));
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
  beforeEach(() => emit.mockClear());
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
    expect(emit.mock.calls.some(([event]) => event.type === 'window:renamed')).toBe(code === 0);
    await app.close();
  });
});
