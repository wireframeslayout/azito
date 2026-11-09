import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { IProjectRepository } from '../../projects/Project';
import type { IStorageSettingsRepository } from '../SqliteStorageSettingsRepository';
import type { MinioStorageClient } from './MinioStorageClient';
import { StorageOperationError, validateStoragePath } from './storageOperations';
import { classifyStorageError } from './storageErrors';
import { isBase64 } from '../validateBase64';

const path = z.string();
const paths = z.array(path).max(1000);
const selection = { keys: paths, prefixes: paths };
const querySchema = z.object({ prefix: z.string().default(''), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) });
const folderSchema = z.object({ prefix: path });
const renameSchema = z.union([z.object({ key: path, displayName: z.string().min(1) }).strict(), z.object({ prefix: path, newName: z.string().min(1) }).strict()]);
const moveSchema = z.object({ ...selection, destPrefix: z.string() });
const deleteSchema = z.object(selection);
const statSchema = z.object({ prefix: z.string() });
/** Reasons a latest version is no longer editable text; sent with a conflict so the editor can say why. */
const UNEDITABLE_CODES: ReadonlySet<string> = new Set(['too_large', 'binary', 'invalid_utf8']);
const contentQuery = z.object({ key: path });
const contentBody = z.object({ key: path, content: z.string(), baseEtag: z.string().min(1).optional(), force: z.boolean().optional() }).refine((value) => value.force === true || value.baseEtag !== undefined);

export interface StorageOperationRouteOptions {
  projectRepo: IProjectRepository;
  storageSettingsRepo: IStorageSettingsRepository;
  storageClient: MinioStorageClient;
}

export function registerStorageOperationRoutes(fastify: FastifyInstance, opts: StorageOperationRouteOptions): void {
  const root = '/api/projects/:id/storage';
  const relativeKey = (key: string, id: number): string => {
    const rootKey = `projects/${id}/`;
    if (!key.startsWith(rootKey)) throw new StorageOperationError(400, 'invalid_path', 'Invalid storage key');
    const relative = key.slice(rootKey.length);
    return validateStoragePath(relative, false);
  };
  function route<S extends z.ZodType>(method: 'GET' | 'POST' | 'PATCH' | 'PUT', suffix: string, schema: S, action: (input: z.output<S>, id: number, reply: FastifyReply) => Promise<unknown>, bodyLimit?: number): void {
    fastify.route({ method, url: root + suffix, ...(bodyLimit ? { bodyLimit } : {}), handler: async (request, reply) => {
      const id = Number((request.params as { id: string }).id);
      if (!Number.isSafeInteger(id) || !opts.projectRepo.findById(id)) return reply.status(404).send({ error: 'Project not found' });
      const parsed = schema.safeParse(method === 'GET' ? request.query : request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', code: 'invalid_request' });
      try { return await action(parsed.data, id, reply); }
      catch (error) {
        if (error instanceof StorageOperationError) return reply.status(error.status).send({ error: error.message, code: error.code });
        request.log.error(error);
        return reply.status(502).send(classifyStorageError(error));
      }
    } });
  }
  function register<S extends z.ZodType>(method: 'GET' | 'POST' | 'PATCH', suffix: string, schema: S, action: (ops: ReturnType<MinioStorageClient['operations']>, input: z.output<S>, id: number) => Promise<unknown>): void {
    route(method, suffix, schema, (input, id) => action(opts.storageClient.operations(opts.storageSettingsRepo.get(), id), input, id));
  }
  const textContent = (id: number) => opts.storageClient.textContent(opts.storageSettingsRepo.get(), id);
  const binaryContent = (id: number) => opts.storageClient.binaryContent(opts.storageSettingsRepo.get(), id);
  route('GET', '/object', contentQuery, async (q: z.infer<typeof contentQuery>, id) => {
    const result = await binaryContent(id).read(relativeKey(q.key, id));
    return { content: result.data.toString('base64'), etag: result.etag };
  });
  route('PUT', '/object', contentBody, async (body: z.infer<typeof contentBody>, id) => {
    if (!isBase64(body.content)) throw new StorageOperationError(400, 'invalid_request', 'Invalid binary content');
    return binaryContent(id).write(relativeKey(body.key, id), Buffer.from(body.content, 'base64'), body.force ? undefined : body.baseEtag);
  }, 28 * 1024 * 1024);
  route('GET', '/content', contentQuery, (q: z.infer<typeof contentQuery>, id) => textContent(id).read(relativeKey(q.key, id)));
  route('PUT', '/content', contentBody, async (b: z.infer<typeof contentBody>, id, reply) => {
    const text = textContent(id);
    const relative = relativeKey(b.key, id);
    try { return await text.write(relative, b.content, b.force ? undefined : b.baseEtag); }
    catch (error) {
      if (!(error instanceof StorageOperationError) || error.code !== 'conflict') throw error;
      let latest: Awaited<ReturnType<typeof text.read>> | { error: string; code: string } | null = null;
      try { latest = await text.read(relative); }
      catch (readError) {
        // A latest version that is no longer editable text carries its reason; one that cannot be read at all is `null`.
        if (readError instanceof StorageOperationError && UNEDITABLE_CODES.has(readError.code)) latest = { error: readError.message, code: readError.code };
        else reply.log.warn({ err: readError }, 'storage conflict: latest content unreadable');
      }
      return reply.status(409).send(latest && 'etag' in latest ? { error: 'conflict', etag: latest.etag, content: latest.content } : { error: 'conflict', latest });
    }
  });
  register('GET', '/entries', querySchema, (ops, q: z.infer<typeof querySchema>) => ops.listPage(q.prefix, q.limit, q.cursor));
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
