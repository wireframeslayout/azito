import type { FastifyPluginCallback } from 'fastify';
import type { IServerRepository } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import { GitDiffService, SAFE_PATH, SAFE_BRANCH, SAFE_HASH } from './GitDiffService';

export interface GitRouteOptions {
  serverRepo: IServerRepository;
  transportFactory: TransportFactory;
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
  fastify.get<{ Params: { name: string }; Querystring: { path?: string; base?: string; commit?: string } }>(
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

      try {
        return await gitDiffService.getDiff(srv, dirPath, base, commit || undefined);
      } catch (e) {
        return reply.status(500).send({ error: e instanceof Error ? e.message : 'Failed to get diff' });
      }
    },
  );

  done();
};

export default gitRoutes;
