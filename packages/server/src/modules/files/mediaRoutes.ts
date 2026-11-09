import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import { MediaService, mediaType } from './mediaService';
import { parseMediaRange } from './mediaRange';

export function registerMediaRoutes(app: FastifyInstance, service: MediaService): void {
  app.get<{ Params: { id: string }; Querystring: { key?: string } }>('/api/projects/:id/storage/media-url', async (request, reply) => {
    const projectId = Number(request.params.id);
    if (!Number.isSafeInteger(projectId) || projectId <= 0 || !request.query.key) return reply.status(400).send({ error: 'Invalid media target' });
    try { return { url: await service.issue({ kind: 'storage', projectId, key: request.query.key }) }; }
    catch { return reply.status(400).send({ error: 'Unable to open media' }); }
  });
  app.get<{ Params: { name: string }; Querystring: { path?: string; projectId?: string } }>('/api/servers/:name/files/media-url', async (request, reply) => {
    const projectId = Number(request.query.projectId);
    if (!Number.isSafeInteger(projectId) || projectId <= 0 || !request.query.path) return reply.status(400).send({ error: 'Invalid media target' });
    try { return { url: await service.issue({ kind: 'server', projectId, server: request.params.name, path: request.query.path }) }; }
    catch { return reply.status(400).send({ error: 'Unable to open media' }); }
  });
  app.get<{ Params: { token: string } }>('/api/media/:token', async (request, reply) => {
    const target = service.parse(request.params.token);
    if (!target) return reply.status(401).send({ error: 'Unauthorized' });
    try {
      await service.validate(target);
      if (target.kind === 'server') {
        const file = await service.serverFile(target);
        const range = parseMediaRange(request.headers.range, file.buffer.length);
        reply.header('Accept-Ranges', 'bytes').header('Content-Type', mediaType(target.path)).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store');
        if (range.kind === 'invalid') return reply.status(416).header('Content-Range', `bytes */${file.buffer.length}`).send();
        if (range.kind === 'partial') return reply.status(206).header('Content-Range', `bytes ${range.start}-${range.end}/${file.buffer.length}`).send(file.buffer.subarray(range.start, range.end + 1));
        return reply.send(file.buffer);
      }
      const storage = service.storage(target.projectId);
      const path = service.storagePath(target);
      const stat = await storage.statMedia(path);
      const range = parseMediaRange(request.headers.range, stat.size);
      reply.header('Accept-Ranges', 'bytes').header('Content-Type', mediaType(target.key)).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store');
      if (range.kind === 'invalid') return reply.status(416).header('Content-Range', `bytes */${stat.size}`).send();
      if (stat.size === 0) return reply.header('Content-Length', 0).send();
      const stream = await storage.streamMedia(path, stat.etag, range.kind === 'partial' ? `bytes=${range.start}-${range.end}` : undefined) as Readable;
      reply.raw.on('close', () => stream.destroy());
      if (range.kind === 'partial') reply.status(206).header('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`).header('Content-Length', range.end - range.start + 1);
      else reply.header('Content-Length', stat.size);
      return reply.send(stream);
    } catch { return reply.status(404).send({ error: 'Unable to open media' }); }
  });
}
