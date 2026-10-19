import { z } from 'zod';
import type { HostPlatform } from '../os/hostEnv';
import {
  FileOpsError,
  type DirEntry,
  type FileContent,
  type FileStat,
  type IFileOps,
  type WalkOptions,
  type WalkResult,
  type WriteOptions,
  type WriteResult,
} from './fileOps';

/** Agent endpoint (behind the agent token) that performs one {@link IFileOps} operation on the agent's host. */
export const AGENT_FILE_OPS_PATH = '/api/fileops';

/** The most bytes one read returns or one write carries. */
export const MAX_FILE_OPS_BYTES = 64 * 1024 * 1024;
/** The request body limit of the endpoint: a write at the byte limit, as base64, plus the envelope. */
export const FILE_OPS_BODY_LIMIT = Math.ceil(MAX_FILE_OPS_BYTES / 3) * 4 + 4096;

/** What one walk request may ask for. The time budget leaves room, within the hub's HTTP deadline for a file operation, for the answer to come back. */
export const MAX_WALK_ENTRIES = 1_000_000;
export const MAX_WALK_TIME_BUDGET_MS = 45_000;
const MAX_WALK_EXCLUDES = 100;

const filePath = z.string().min(1);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** One operation, as the hub sends it. Validated on the agent: this is the edge a request crosses. */
export const fileOpRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list'), path: filePath }),
  z.object({ op: z.literal('stat'), path: filePath, followLinks: z.boolean().optional(), withAge: z.boolean().optional() }),
  z.object({ op: z.literal('read'), path: filePath, maxBytes: z.number().int().positive().max(MAX_FILE_OPS_BYTES).optional(),
    headBytes: z.number().int().positive().max(MAX_FILE_OPS_BYTES).optional(),
  }),
  z.object({
    op: z.literal('write'),
    path: filePath,
    dataBase64: z.string(),
    expect: z.object({ mtimeMs: z.number().optional(), sha256: sha256.optional() }).optional(),
  }),
  z.object({ op: z.literal('create'), path: filePath, kind: z.enum(['file', 'directory']), recursive: z.boolean().optional() }),
  z.object({ op: z.literal('remove'), path: filePath }),
  z.object({ op: z.literal('rename'), from: filePath, to: filePath }),
  z.object({ op: z.literal('replaceDirectory'), staging: filePath, target: filePath }),
  z.object({
    op: z.literal('walk'),
    path: filePath,
    excludeNames: z.array(z.string()).max(MAX_WALK_EXCLUDES),
    maxEntries: z.number().int().positive().max(MAX_WALK_ENTRIES),
    timeBudgetMs: z.number().int().positive().max(MAX_WALK_TIME_BUDGET_MS),
  }),
  z.object({ op: z.literal('realpath'), path: filePath }),
]);
export type FileOpRequest = z.infer<typeof fileOpRequestSchema>;

const entryKind = z.enum(['file', 'directory', 'symlink', 'other']);
const fileStatSchema = z.object({ kind: entryKind, size: z.number(), mtimeMs: z.number(), mode: z.number(), ageMs: z.number().optional() });
const errorCode = z.enum(['NOT_FOUND', 'NOT_A_DIRECTORY', 'NOT_A_FILE', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'TOO_LARGE', 'CONFLICT', 'SYMLINK_REFUSED', 'INVALID_PATH', 'FAILED']);

/** The body of a response: the result, or the {@link FileOpsError} the operation ended with (HTTP 200 for both; a bad request is 400). */
const fileOpResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    code: errorCode,
    message: z.string(),
    details: z.object({ size: z.number().optional(), currentMtimeMs: z.number().nullable().optional(), hashUnavailable: z.boolean().optional() }),
  }),
]);
export type FileOpResponse = z.infer<typeof fileOpResponseSchema>;

const resultSchemas = {
  list: z.array(z.object({ name: z.string(), kind: entryKind, size: z.number().optional(), mtimeMs: z.number().optional() })),
  stat: fileStatSchema.nullable(),
  read: z.object({ dataBase64: z.string(), stat: fileStatSchema }),
  write: z.object({ mtimeMs: z.number(), sha256 }),
  create: z.object({ created: z.boolean() }),
  remove: z.null(),
  rename: z.null(),
  replaceDirectory: z.null(),
  walk: z.object({ entries: z.array(z.object({ path: z.string(), mtimeMs: z.number() })), truncated: z.boolean() }),
  realpath: z.string(),
};

async function perform(ops: IFileOps, request: FileOpRequest): Promise<unknown> {
  switch (request.op) {
    case 'list': return ops.list(request.path);
    case 'stat': return ops.stat(request.path, { followLinks: request.followLinks, withAge: request.withAge });
    case 'read': {
      // A head read returns at most `headBytes`, so the size limit of a whole read does not apply to it.
      const maxBytes = request.maxBytes ?? (request.headBytes === undefined ? MAX_FILE_OPS_BYTES : undefined);
      const { data, stat } = await ops.read(request.path, { maxBytes, headBytes: request.headBytes });
      return { dataBase64: data.toString('base64'), stat };
    }
    case 'write': {
      const data = Buffer.from(request.dataBase64, 'base64');
      if (data.length > MAX_FILE_OPS_BYTES) throw new FileOpsError('TOO_LARGE', `Content too large (${data.length} bytes, limit ${MAX_FILE_OPS_BYTES})`, { size: data.length });
      return ops.write(request.path, data, { expect: request.expect });
    }
    case 'create': return ops.create(request.path, request.kind, { recursive: request.recursive });
    case 'remove': await ops.remove(request.path); return null;
    case 'rename': await ops.rename(request.from, request.to); return null;
    case 'replaceDirectory': await ops.replaceDirectory(request.staging, request.target); return null;
    case 'walk': return ops.walk(request.path, { excludeNames: request.excludeNames, maxEntries: request.maxEntries, timeBudgetMs: request.timeBudgetMs });
    case 'realpath': return ops.realpath(request.path);
  }
}

/** The agent side: performs the operation with the same code the hub uses for its own files and reports how it ended. Unexpected errors propagate. */
export async function executeFileOp(ops: IFileOps, request: FileOpRequest): Promise<FileOpResponse> {
  try {
    return { ok: true, result: await perform(ops, request) };
  } catch (err) {
    if (err instanceof FileOpsError) return { ok: false, code: err.code, message: err.message, details: err.details };
    throw err;
  }
}

/**
 * The hub side: an {@link IFileOps} whose every operation is one request to an agent's `POST /api/fileops`. `send` carries a
 * request and returns the response body (it throws for an agent that cannot be reached or that answered with an HTTP error).
 */
export class RemoteFileOps implements IFileOps {
  constructor(readonly platform: HostPlatform, private readonly send: (request: FileOpRequest) => Promise<unknown>) {}

  private async call<K extends keyof typeof resultSchemas>(op: K, request: FileOpRequest): Promise<z.infer<(typeof resultSchemas)[K]>> {
    const response = fileOpResponseSchema.parse(await this.send(request));
    if (!response.ok) throw new FileOpsError(response.code, response.message, response.details);
    return resultSchemas[op].parse(response.result) as z.infer<(typeof resultSchemas)[K]>;
  }

  list(path: string): Promise<DirEntry[]> {
    return this.call('list', { op: 'list', path });
  }

  stat(path: string, options: { followLinks?: boolean; withAge?: boolean } = {}): Promise<FileStat | null> {
    return this.call('stat', { op: 'stat', path, followLinks: options.followLinks, withAge: options.withAge });
  }

  async read(path: string, options: { maxBytes?: number; headBytes?: number } = {}): Promise<FileContent> {
    const { dataBase64, stat } = await this.call('read', { op: 'read', path, maxBytes: options.maxBytes, headBytes: options.headBytes });
    return { data: Buffer.from(dataBase64, 'base64'), stat };
  }

  write(path: string, data: Buffer, options: WriteOptions = {}): Promise<WriteResult> {
    return this.call('write', { op: 'write', path, dataBase64: data.toString('base64'), expect: options.expect });
  }

  create(path: string, kind: 'file' | 'directory', options: { recursive?: boolean } = {}): Promise<{ created: boolean }> {
    return this.call('create', { op: 'create', path, kind, recursive: options.recursive });
  }

  async remove(path: string): Promise<void> {
    await this.call('remove', { op: 'remove', path });
  }

  async rename(from: string, to: string): Promise<void> {
    await this.call('rename', { op: 'rename', from, to });
  }

  async replaceDirectory(staging: string, target: string): Promise<void> {
    await this.call('replaceDirectory', { op: 'replaceDirectory', staging, target });
  }

  walk(root: string, options: WalkOptions): Promise<WalkResult> {
    return this.call('walk', { op: 'walk', path: root, excludeNames: options.excludeNames, maxEntries: options.maxEntries, timeBudgetMs: options.timeBudgetMs });
  }

  realpath(path: string): Promise<string> {
    return this.call('realpath', { op: 'realpath', path });
  }
}
