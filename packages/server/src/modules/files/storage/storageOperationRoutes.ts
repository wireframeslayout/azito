import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IProjectRepository } from '../../projects/Project';
import type { IStorageSettingsRepository } from '../SqliteStorageSettingsRepository';
import type { MinioStorageClient } from './MinioStorageClient';
import { StorageOperationError, validateStoragePath } from './storageOperations';
import { classifyStorageError } from './storageErrors';

const path = z.string();
const paths = z.array(path).max(1000);
const selection = { keys: paths, prefixes: paths };
const querySchema = z.object({ prefix: z.string().default(''), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) });
const folderSchema = z.object({ prefix: path });
const renameSchema = z.union([z.object({ key: path, displayName: z.string().min(1) }).strict(), z.object({ prefix: path, newName: z.string().min(1) }).strict()]);
const moveSchema = z.object({ ...selection, destPrefix: z.string() });
const deleteSchema = z.object(selection);
const statSchema = z.object({ prefix: z.string() });

export interface StorageOperationRouteOptions {
  projectRepo: IProjectRepository;
  storageSettingsRepo: IStorageSettingsRepository;
  storageClient: MinioStorageClient;
}

export function registerStorageOperationRoutes(fastify: FastifyInstance, opts: StorageOperationRouteOptions): void {
  const root = '/api/projects/:id/storage';
  function register<S extends z.ZodType>(method: 'GET' | 'POST' | 'PATCH', suffix: string, schema: S, action: (ops: ReturnType<MinioStorageClient['operations']>, input: z.output<S>, id: number) => Promise<unknown>): void {
    fastify.route({ method, url: root + suffix, handler: async (request, reply) => {
      const id = Number((request.params as { id: string }).id);
      if (!Number.isSafeInteger(id) || !opts.projectRepo.findById(id)) return reply.status(404).send({ error: 'Project not found' });
      const parsed = schema.safeParse(method === 'GET' ? request.query : request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', code: 'invalid_request' });
      try { return await action(opts.storageClient.operations(opts.storageSettingsRepo.get(), id), parsed.data, id); }
      catch (error) {
        if (error instanceof StorageOperationError) return reply.status(error.status).send({ error: error.message, code: error.code });
        request.log.error(error);
        return reply.status(502).send(classifyStorageError(error));
      }
    } });
  }
  const contentQuery = z.object({ key: path });
  const contentBody = z.object({ key: path, content: z.string(), version: z.string().min(1).optional(), force: z.boolean().optional() }).refine((value) => value.force === true || value.version !== undefined);
  for (const method of ['GET', 'PUT'] as const) {
    fastify.route({ method, url: root + '/content', handler: async (request, reply) => {
      const id = Number((request.params as { id: string }).id);
      if (!Number.isSafeInteger(id) || !opts.projectRepo.findById(id)) return reply.status(404).send({ error: 'Project not found' });
      const parsed = method === 'GET' ? contentQuery.safeParse(request.query) : contentBody.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', code: 'invalid_request' });
      try {
        const text = opts.storageClient.textContent(opts.storageSettingsRepo.get(), id);
        const relative = relativeKey(parsed.data.key, id);
        if (method === 'GET') return await text.read(relative);
        const body = contentBody.parse(parsed.data);
        try { return await text.write(relative, body.content, body.force ? undefined : body.version); }
        catch (error) {
          if (error instanceof StorageOperationError && error.code === 'conflict') {
            try { return reply.status(409).send({ code: 'conflict', latest: await text.read(relative) }); }
            catch { return reply.status(409).send({ code: 'conflict', latest: null }); }
          }
          throw error;
        }
      } catch (error) {
        if (error instanceof StorageOperationError) return reply.status(error.status).send({ error: error.message, code: error.code });
        request.log.error(error);
        return reply.status(502).send(classifyStorageError(error));
      }
    } });
  }
  register('GET', '/entries', querySchema, (ops, q: z.infer<typeof querySchema>) => ops.listPage(q.prefix, q.limit, q.cursor));
  const relativeKey = (key: string, id: number): string => {
    const rootKey = `projects/${id}/`;
    if (!key.startsWith(rootKey)) throw new StorageOperationError(400, 'invalid_path', 'Invalid storage key');
    const relative = key.slice(rootKey.length);
    return validateStoragePath(relative, false);
  };
  const resolveSelection = (keys: string[], prefixes: string[], id: number): string[] => {
    const result = [...keys.map((key) => relativeKey(key, id)), ...prefixes.map((prefix) => validateStoragePath(prefix, true))];
    if (!result.length || new Set(result).size !== result.length) throw new StorageOperationError(400, 'invalid_request', 'Invalid selection');
    return result;
  };
  register('POST', '/folders', folderSchema, async (ops, b: z.infer<typeof folderSchema>) => { await ops.createFolder(b.prefix); return { ok: true }; });
  register('PATCH', '/entries', renameSchema, async (ops, b: z.infer<typeof renameSchema>, id) => {
    if ('prefix' in b) await ops.renameFolder(b.prefix, b.newName);
    else await ops.renameFile(relativeKey(b.key, id), b.displayName);
    return { ok: true };
  });
  register('POST', '/move', moveSchema, async (ops, b: z.infer<typeof moveSchema>, id) => { await ops.moveObjects(resolveSelection(b.keys, b.prefixes, id), b.destPrefix); return { ok: true }; });
  register('POST', '/delete', deleteSchema, async (ops, b: z.infer<typeof deleteSchema>, id) => { await ops.deletePaths(resolveSelection(b.keys, b.prefixes, id)); return { ok: true }; });
  register('GET', '/stat', statSchema, (ops, q: z.infer<typeof statSchema>) => ops.statPrefix(q.prefix));
}
