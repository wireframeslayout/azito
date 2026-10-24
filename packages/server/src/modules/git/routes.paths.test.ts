import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import gitRoutes, { type GitRouteOptions } from './routes';
import type { HostProfile } from '../../shared/os/hostProfile';
import type { WorktreeEntry } from './IWorktreeService';
import type { CommandSpec } from '../../shared/exec/commandSpec';
import { ok } from '../../shared/exec/testing/commandTesting';

interface TaskStub {
  id: number;
  title: string;
  status: string;
  worktreePath: string | null;
}

async function build(profile: HostProfile | null, entries: WorktreeEntry[] = [], tasks: TaskStub[] = []): Promise<{ app: FastifyInstance; specs: CommandSpec[] }> {
  const specs: CommandSpec[] = [];
  const transport = { run: vi.fn(async (spec: CommandSpec) => { specs.push(spec); return ok(''); }), hostProfile: profile };
  const opts = {
    serverRepo: { findByName: () => ({ name: 'srv', type: 'agent', hostProfile: profile }) },
    transportFactory: { hostProfileFor: () => profile, getTransport: () => transport },
    taskRepo: { findById: (id: number) => tasks.find((t) => t.id === id) ?? null },
    projectServerRepo: { find: () => ({ workingDirectory: '/repo' }) },
    worktreeServiceFactory: { create: () => ({ list: async () => entries }) },
  } as unknown as GitRouteOptions;
  const app = Fastify();
  await app.register(gitRoutes, opts);
  await app.ready();
  return { app, specs };
}

const linux: HostProfile = { platform: 'linux', arch: 'x64' };
const entry = (path: string, isMain = false): WorktreeEntry => ({ path, branch: 'b', head: 'abc', isMain, locked: false });

describe('git read routes: the path argument', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it.each(['commits', 'diff'])('%s takes a POSIX path with spaces and Japanese characters as one argv element', async (route) => {
    const built = await build(linux);
    app = built.app;
    const path = '/home/u/my repo/日本語';
    const res = await app.inject({ method: 'GET', url: `/api/servers/srv/git/${route}?path=${encodeURIComponent(path)}&scope=commit&commit=abc1234` });
    expect(res.statusCode).toBe(200);
    expect(built.specs[0].args).toContain(path);
  });

  it.each(['commits', 'diff'])('%s refuses a relative path, a NUL byte and an option-like path with 400', async (route) => {
    const built = await build(linux);
    app = built.app;
    for (const path of ['repo/sub', '/repo\u0000x', '-c/evil', 'C:\\Users\\x y\\日本語']) {
      const res = await app.inject({ method: 'GET', url: `/api/servers/srv/git/${route}?path=${encodeURIComponent(path)}` });
      expect(res.statusCode, path).toBe(400);
      expect(res.json()).toEqual({ error: 'Invalid path' });
    }
    expect(built.specs).toHaveLength(0);
  });
});

describe('GET /api/servers/:name/git/worktrees: task link', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  const taskOf = (body: { worktrees: Array<{ path: string; taskId: number | null; orphaned: boolean }> }, path: string) => body.worktrees.find((w) => w.path === path)!;

  it('links the task whose recorded worktree is the listed path, and leaves one of another repository unlinked', async () => {
    const built = await build(
      linux,
      [entry('/repo', true), entry('/repo/.worktrees/task-1'), entry('/repo/.worktrees/task-2'), entry('/repo/.worktrees/task-3')],
      [
        { id: 1, title: 't1', status: 'review', worktreePath: '/repo/.worktrees/task-1/' },
        { id: 2, title: 't2', status: 'review', worktreePath: '/other/.worktrees/task-2' },
      ],
    );
    app = built.app;
    const body = (await app.inject({ method: 'GET', url: '/api/servers/srv/git/worktrees?project_id=1' })).json();
    expect(taskOf(body, '/repo/.worktrees/task-1')).toMatchObject({ taskId: 1, orphaned: false });
    expect(taskOf(body, '/repo/.worktrees/task-2')).toMatchObject({ taskId: null, orphaned: false });
    expect(taskOf(body, '/repo/.worktrees/task-3')).toMatchObject({ taskId: null, orphaned: true });
    expect(taskOf(body, '/repo')).toMatchObject({ taskId: null, orphaned: false });
  });
});
