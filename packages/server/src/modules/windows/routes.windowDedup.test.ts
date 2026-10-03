import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { formatMuxRef } from '@azito/shared';
import windowsRoutes from './routes';
import { SqliteWindowRepository } from './SqliteWindowRepository';
import { buildSeededDb, insertProject, insertTask } from './windowTestDb';
import { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { IMuxClient } from '../tmux/IMuxClient';

// Window registration against the real SQLite repository: one physical window = one row, however it is registered
// (ref only → tmux_target `ws:w_<id>`, or a window-name tmux_target + ref, or the whole-session registration).
const MISAO_REF = { kind: 'misao', workspace: 'azito', window: 'w_01M40229BC46M2RPATEBX4JN25' } as const;
const REF_ONLY_TARGET = 'azito:w_01M40229BC46M2RPATEBX4JN25';
const NAMED_TARGET = 'azito:test-window--nksu';

async function setup() {
  const db = buildSeededDb();
  const repo = new SqliteWindowRepository(db);
  const projectId = insertProject(db, 'P');
  const taskId = insertTask(db, projectId, 'T');
  const registry = new MuxDriverRegistry({ misaoEnabled: true });
  registry.register('misao', {
    kind: 'misao',
    supportsPaneLabels: false,
    listWorkspaces: async () => [{
      name: 'azito', windowCount: 1, attached: false, created: 0,
      windows: [{ index: 0, name: 'test-window--nksu', ref: MISAO_REF, panes: [] }],
    }],
  } as unknown as IMuxClient);
  const app = Fastify();
  await app.register(windowsRoutes, {
    windowRepo: repo,
    projectRepo: { findById: () => ({ id: projectId }) },
    taskRepo: { findById: () => ({ id: taskId }) },
    serverRepo: { findByName: () => ({ name: 'local-misao', muxRuntime: 'misao' }) },
    muxDriverRegistry: registry,
    sessionCaptureService: { scheduleInitialScan: vi.fn() },
  } as never);
  await app.ready();
  const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, payload: { server_name: 'local-misao', ...payload } });
  return { repo, projectId, taskId, post };
}

describe('window registration routes share one row per physical misao window (real repository)', () => {
  it('ref-only registration, then named tmux_target + ref, adopts the same row', async () => {
    const { repo, projectId, taskId, post } = await setup();
    const first = await post(`/api/projects/${projectId}/windows`, { ref: formatMuxRef(MISAO_REF) });
    expect(first.statusCode).toBe(200);
    expect(repo.findByServerAndRef('local-misao', MISAO_REF)?.tmuxTarget).toBe(REF_ONLY_TARGET);

    const second = await post(`/api/tasks/${taskId}/windows`, { tmux_target: NAMED_TARGET, ref: formatMuxRef(MISAO_REF) });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ id: first.json().id, adopted: true });
  });

  it('named tmux_target + ref registration, then ref-only, reuses the same row', async () => {
    const { projectId, taskId, post } = await setup();
    const first = await post(`/api/projects/${projectId}/windows`, { tmux_target: NAMED_TARGET, ref: formatMuxRef(MISAO_REF) });
    expect(first.statusCode).toBe(200);

    const second = await post(`/api/tasks/${taskId}/windows`, { ref: formatMuxRef(MISAO_REF) });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ id: first.json().id, adopted: true });

    const again = await post(`/api/projects/${projectId}/windows`, { ref: formatMuxRef(MISAO_REF) });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.json().id);
  });

  it('whole-session registration reuses a window already registered by ref only', async () => {
    const { projectId, post } = await setup();
    const first = await post(`/api/projects/${projectId}/windows`, { ref: formatMuxRef(MISAO_REF) });
    expect(first.statusCode).toBe(200);

    const session = await post(`/api/projects/${projectId}/windows/session`, { session: 'azito' });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ ok: true, count: 1, ids: [first.json().id] });
  });
});

describe('registration without a ref on a misao server', () => {
  it('is rejected with 400 for project and task registration and stores no row', async () => {
    const { repo, projectId, taskId, post } = await setup();
    const project = await post(`/api/projects/${projectId}/windows`, { tmux_target: NAMED_TARGET });
    const task = await post(`/api/tasks/${taskId}/windows`, { tmux_target: NAMED_TARGET });
    expect(project.statusCode).toBe(400);
    expect(task.statusCode).toBe(400);
    expect(repo.findByServerAndTarget('local-misao', NAMED_TARGET)).toBeUndefined();
  });

  it('task registration by ref reports the row target so the client selects the stored row', async () => {
    const { projectId, taskId, post } = await setup();
    await post(`/api/projects/${projectId}/windows/session`, { session: 'azito' });
    const res = await post(`/api/tasks/${taskId}/windows`, { tmux_target: REF_ONLY_TARGET, ref: formatMuxRef(MISAO_REF) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ adopted: true, tmuxTarget: NAMED_TARGET });
  });
});
