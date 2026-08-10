import type { FastifyPluginCallback } from 'fastify';
import type { IServerRepository } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { ITaskRepository } from '../tasks/Task';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import { GitDiffService, SAFE_PATH, SAFE_BRANCH, SAFE_HASH, type DiffScope } from './GitDiffService';
import type { WorktreeServiceFactory } from './WorktreeServiceFactory';
import { shellQuote } from '../../shared/shellQuote';

const VALID_SCOPES = new Set<string>(['uncommitted', 'base', 'commit']);

export interface GitRouteOptions {
  serverRepo: IServerRepository;
  transportFactory: TransportFactory;
  taskRepo?: ITaskRepository;
  projectServerRepo?: IProjectServerRepository;
  worktreeServiceFactory?: WorktreeServiceFactory;
}

const gitRoutes: FastifyPluginCallback<GitRouteOptions> = (fastify, opts, done) => {
  const { serverRepo, transportFactory } = opts;
  const gitDiffService = new GitDiffService(transportFactory);

  // ── GET /api/servers/:name/git/commits ──
  fastify.get<{ Params: { name: string }; Querystring: { path?: string; base?: string } }>(
    '/api/servers/:name/git/commits',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const dirPath = (request.query.path || '').trim();
      if (!dirPath) return reply.status(400).send({ error: 'path query parameter required' });
      if (!SAFE_PATH.test(dirPath)) return reply.status(400).send({ error: 'Invalid path' });

      const base = (request.query.base || '').trim();
      if (base && !SAFE_BRANCH.test(base)) return reply.status(400).send({ error: 'Invalid base branch' });

      try {
        return await gitDiffService.getCommits(srv, dirPath, base || undefined);
      } catch (e) {
        return reply.status(500).send({ error: e instanceof Error ? e.message : 'Failed to get commits' });
      }
    },
  );

  // ── GET /api/servers/:name/git/diff ──
  fastify.get<{ Params: { name: string }; Querystring: { path?: string; base?: string; commit?: string; scope?: string; includeUncommitted?: string } }>(
    '/api/servers/:name/git/diff',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const dirPath = (request.query.path || '').trim();
      if (!dirPath) return reply.status(400).send({ error: 'path query parameter required' });
      if (!SAFE_PATH.test(dirPath)) return reply.status(400).send({ error: 'Invalid path' });

      const base = (request.query.base || '').trim();
      if (base && !SAFE_BRANCH.test(base)) return reply.status(400).send({ error: 'Invalid base branch' });

      const commit = (request.query.commit || '').trim();
      if (commit && !SAFE_HASH.test(commit)) return reply.status(400).send({ error: 'Invalid commit hash' });

      const scopeRaw = (request.query.scope || '').trim();
      if (scopeRaw && !VALID_SCOPES.has(scopeRaw)) return reply.status(400).send({ error: 'Invalid scope' });
      const scope = scopeRaw as DiffScope | undefined;

      const includeUncommittedRaw = (request.query.includeUncommitted || '').trim();
      const includeUncommitted = includeUncommittedRaw === '' ? undefined : includeUncommittedRaw !== 'false';

      try {
        return await gitDiffService.getDiff(srv, dirPath, base, commit || undefined, {
          scope: scope || undefined,
          includeUncommitted,
        });
      } catch (e) {
        return reply.status(500).send({ error: e instanceof Error ? e.message : 'Failed to get diff' });
      }
    },
  );

  // ── GET /api/servers/:name/git/worktrees ──
  fastify.get<{ Params: { name: string }; Querystring: { project_id?: string } }>(
    '/api/servers/:name/git/worktrees',
    async (request, reply) => {
      const { worktreeServiceFactory: wsf, taskRepo, projectServerRepo } = opts;
      if (!wsf || !taskRepo || !projectServerRepo) {
        return reply.status(501).send({ error: 'Worktree listing not configured' });
      }

      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const projectId = request.query.project_id ? parseInt(request.query.project_id, 10) : NaN;
      if (isNaN(projectId)) return reply.status(400).send({ error: 'project_id query parameter required' });

      const projectServer = projectServerRepo.find(projectId, request.params.name);
      const workingDir = projectServer?.workingDirectory;
      if (!workingDir) return reply.status(400).send({ error: 'No working directory configured for this project server' });

      try {
        const transport = transportFactory.getTransport(srv);
        const worktreeService = wsf.create(srv.type, transport);
        const entries = await worktreeService.list(workingDir);

        const changedCounts = await Promise.all(
          entries.map(async (entry) => {
            try {
              const r = await transport.exec(`git -C ${shellQuote(entry.path)} status --porcelain`, 10000);
              const lines = r.stdout.trim();
              return lines === '' ? 0 : lines.split('\n').length;
            } catch {
              return null;
            }
          }),
        );

        const worktrees = entries.map((entry, i) => {
          const match = entry.path.match(/\/\.worktrees\/task-(\d+)$/);
          const task = match ? taskRepo.findById(parseInt(match[1], 10)) : null;
          return {
            path: entry.path,
            branch: entry.branch,
            head: entry.head,
            isMain: entry.isMain,
            locked: entry.locked,
            taskId: task?.id ?? null,
            taskTitle: task?.title ?? null,
            taskStatus: task?.status ?? null,
            orphaned: match != null && task == null,
            changedCount: changedCounts[i],
          };
        });

        return { worktrees };
      } catch (error) {
        return reply.status(500).send({ error: error instanceof Error ? error.message : 'Failed to list worktrees' });
      }
    },
  );

  done();
};

export default gitRoutes;
