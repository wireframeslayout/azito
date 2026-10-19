import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import gitRoutes from './routes';
import type { IWorktreeService, WorktreeEntry } from './IWorktreeService';
import { WorktreeServiceFactory } from './WorktreeServiceFactory';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { IServerRepository } from '../servers/Server';
import type { ITaskRepository } from '../tasks/Task';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import { argvOfShellLine, argvOfSpec, failed, fakeRunTransport, ok } from '../../shared/exec/testing/commandTesting';

const entry = (path: string, isMain = false): WorktreeEntry => ({ path, branch: 'b', head: 'abc', isMain, locked: false });

async function build(entries: WorktreeEntry[], answer: (path: string) => ReturnType<typeof ok>): Promise<{ app: FastifyInstance; specs: ReturnType<typeof fakeRunTransport>['specs'] }> {
  const transport = fakeRunTransport((spec) => answer(spec.args[1]));
  const app = Fastify();
  await app.register(gitRoutes, {
    serverRepo: { findByName: () => ({ name: 's', type: 'local' }) } as unknown as IServerRepository,
    transportFactory: { getTransport: () => transport } as unknown as TransportFactory,
    taskRepo: { findById: () => null } as unknown as ITaskRepository,
    projectServerRepo: { find: () => ({ workingDirectory: '/repo' }) } as unknown as IProjectServerRepository,
    worktreeServiceFactory: { create: (): IWorktreeService => ({ list: async () => entries }) as unknown as IWorktreeService } as unknown as WorktreeServiceFactory,
  });
  await app.ready();
  return { app, specs: transport.specs };
}

describe('GET /api/servers/:name/git/worktrees', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it('counts changed files per worktree with git status run in each path, and null where git fails', async () => {
    const built = await build([entry('/repo', true), entry("/repo/.worktrees/it's"), entry('/repo/.worktrees/broken')], (path) => {
      if (path === '/repo') return ok(' M a.ts\n?? b.ts\n');
      if (path === '/repo/.worktrees/broken') return failed(128, 'fatal: not a git repository');
      return ok('');
    });
    app = built.app;

    const res = await app.inject({ method: 'GET', url: '/api/servers/s/git/worktrees?project_id=1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().worktrees.map((w: { changedCount: number | null }) => w.changedCount)).toEqual([2, 0, null]);
    expect(built.specs[1]).toMatchObject({ file: 'git', args: ['-C', "/repo/.worktrees/it's", 'status', '--porcelain'], timeoutMs: 10000 });
  });

  // A stored working directory of the form ~/... (the shell used to expand it) must still list its worktrees on an agent.
  it('lists the worktrees of a project whose working directory is ~/..., from the route through the remote service', async () => {
    const seen: Array<{ args: string[]; cwd?: string }> = [];
    const transport = {
      run: async (spec: { args: string[]; cwd?: string }) => {
        seen.push(spec);
        if (spec.args[0] === 'worktree') return ok('worktree /home/u/ws/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /home/u/ws/repo/.worktrees/task-3\nHEAD def\nbranch refs/heads/task/3-x\n\n');
        return ok(' M a.ts\n');
      },
      exec: async (command: string) => ({ stdout: command.startsWith('cd -- "$HOME"') ? '/home/u/ws/repo\n' : '', stderr: '', code: 0 }),
    };
    const app = Fastify();
    await app.register(gitRoutes, {
      serverRepo: { findByName: () => ({ name: 's', type: 'agent' }) } as unknown as IServerRepository,
      transportFactory: { getTransport: () => transport } as unknown as TransportFactory,
      taskRepo: { findById: () => null } as unknown as ITaskRepository,
      projectServerRepo: { find: () => ({ workingDirectory: '~/ws/repo' }) } as unknown as IProjectServerRepository,
      worktreeServiceFactory: new WorktreeServiceFactory(),
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/servers/s/git/worktrees?project_id=1' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().worktrees.map((w: { path: string; changedCount: number }) => [w.path, w.changedCount])).toEqual([
      ['/home/u/ws/repo', 1],
      ['/home/u/ws/repo/.worktrees/task-3', 1],
    ]);
    expect(seen[0]).toEqual(expect.objectContaining({ args: ['worktree', 'list', '--porcelain'], cwd: '/home/u/ws/repo' }));
  });

  it.skipIf(process.platform === 'win32')('runs the same argv as the old shell string', async () => {
    const built = await build([entry("/repo/.worktrees/it's here")], () => ok(''));
    app = built.app;
    await app.inject({ method: 'GET', url: '/api/servers/s/git/worktrees?project_id=1' });
    expect(argvOfSpec(built.specs[0])).toEqual(argvOfShellLine("git -C '/repo/.worktrees/it'\\''s here' status --porcelain"));
  });
});
