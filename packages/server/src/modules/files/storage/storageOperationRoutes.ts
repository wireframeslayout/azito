import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StorageRouteOptions } from '../routes';
import { StorageOperationError } from './storageOperations';

const path = z.string();
const paths = z.array(path).min(1).max(1000).refine((items) => new Set(items).size === items.length);
const querySchema = z.object({ prefix: z.string().default(''), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) });
const folderSchema = z.object({ path });
const renameSchema = z.object({ path, newName: z.string().min(1) });
const moveSchema = z.object({ paths, destination: z.string() });
const deleteSchema = z.object({ paths });
const statSchema = z.object({ prefix: z.string() });

export function registerStorageOperationRoutes(fastify: FastifyInstance, opts: StorageRouteOptions): void {
  const root = '/api/projects/:id/storage';
  function register(method: 'GET' | 'POST' | 'PATCH', suffix: string, schema: z.ZodType, action: (ops: ReturnType<StorageRouteOptions['storageClient']['operations']>, input: never) => Promise<unknown>): void {
    fastify.route({ method, url: root + suffix, handler: async (request, reply) => {
      const id = Number((request.params as { id: string }).id);
      if (!Number.isSafeInteger(id) || !opts.projectRepo.findById(id)) return reply.status(404).send({ error: 'Project not found' });
      const parsed = schema.safeParse(method === 'GET' ? request.query : request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', code: 'invalid_request' });
      try { return await action(opts.storageClient.operations(opts.storageSettingsRepo.get(), id), parsed.data as never); }
      catch (error) {
        if (error instanceof StorageOperationError) return reply.status(error.status).send({ error: error.message, code: error.code });
        request.log.error(error);
        return reply.status(502).send({ error: 'Storage operation failed', code: 'storage_error' });
      }
    } });
  }
  register('GET', '/entries', querySchema, (ops, q: z.infer<typeof querySchema>) => ops.listPage(q.prefix, q.limit, q.cursor));
  register('POST', '/folders', folderSchema, async (ops, b: z.infer<typeof folderSchema>) => { await ops.createFolder(b.path); return { ok: true }; });
  register('PATCH', '/entries', renameSchema, async (ops, b: z.infer<typeof renameSchema>) => {
    if (b.path.endsWith('/')) {
      await ops.renameFolder(b.path, b.newName);
    } else await ops.renameFile(b.path, b.newName);
    return { ok: true };
  });
  register('POST', '/move', moveSchema, async (ops, b: z.infer<typeof moveSchema>) => { await ops.moveObjects(b.paths, b.destination); return { ok: true }; });
  register('POST', '/delete', deleteSchema, async (ops, b: z.infer<typeof deleteSchema>) => { await ops.deletePaths(b.paths); return { ok: true }; });
  register('GET', '/stat', statSchema, (ops, q: z.infer<typeof statSchema>) => ops.statPrefix(q.prefix));
}
