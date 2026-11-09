import { z } from 'zod';
import type { FastifyPluginCallback } from 'fastify';
import { parseWindowId } from '@azito/shared';
import type { OrchestrationLinkService } from './OrchestrationLinkService';
import type { IWindowRepository } from '../windows/Window';

interface Options { links: OrchestrationLinkService; windows: IWindowRepository }
const routes: FastifyPluginCallback<Options> = (app, { links, windows }, done) => {
  app.get('/api/orchestrators', async () => links.orchestrators());
  app.get<{ Params: { id: string }; Querystring: { includeUnlinked?: string; kind?: string } }>('/api/windows/:id/links', async (req, reply) => {
    const id = parseWindowId(req.params.id);
    if (id === null || !windows.findById(id)) return reply.status(404).send({ error: 'not_found' });
    const query = z.object({ includeUnlinked: z.enum(['0', '1']).optional(), kind: z.enum(['orchestration', 'operation']).optional() }).strict().safeParse(req.query);
    if (!query.success) return reply.status(400).send({ error: 'invalid_query' });
    return links.list(id, query.data.includeUnlinked === '1', query.data.kind);
  });
  app.post<{ Params: { id: string } }>('/api/windows/:id/links', async (req, reply) => {
    const id = parseWindowId(req.params.id);
    const body = z.union([z.object({ targetWindowId: z.number().int().positive().safe() }).strict(), z.object({ taskId: z.number().int().positive().safe() }).strict()]).safeParse(req.body);
    if (id === null || !windows.findById(id)) return reply.status(404).send({ error: 'not_found' });
    if (!body.success) return reply.status(400).send({ error: 'invalid_target' });
    const result = links.add(id, 'targetWindowId' in body.data ? { windowId: body.data.targetWindowId } : { taskId: body.data.taskId }, 'manual');
    if (typeof result === 'string') return reply.status(result === 'not_found' ? 404 : result === 'already_nested' || result === 'cycle' ? 409 : 422).send({ error: result });
    return links.list(id, true).find((link) => link.id === result.id);
  });
  app.delete<{ Params: { id: string; linkId: string } }>('/api/windows/:id/links/:linkId', async (req, reply) => {
    const id = parseWindowId(req.params.id); const linkId = parseWindowId(req.params.linkId);
    if (id === null || linkId === null || !links.unlink(id, linkId)) return reply.status(404).send({ error: 'not_found' });
    return { ok: true };
  });
  done();
};
export default routes;
