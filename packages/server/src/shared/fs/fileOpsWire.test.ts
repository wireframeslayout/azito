import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { FileOpsError } from './fileOps';
import { executeFileOp, fileOpRequestSchema, MAX_FILE_OPS_BYTES, MAX_WALK_ENTRIES, MAX_WALK_TIME_BUDGET_MS, RemoteFileOps, type FileOpRequest } from './fileOpsWire';
import { LocalFileOps, localFileOpsHost } from './LocalFileOps';

let dir: string;
let local: LocalFileOps;
let sent: FileOpRequest[];
let remote: RemoteFileOps;

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'azito-fileops-wire-')));
  local = new LocalFileOps(localFileOpsHost({ platform: process.platform, homeDir: dir }));
  sent = [];
  // The agent route in one process: the request and the response both go through JSON, as they do over HTTP.
  remote = new RemoteFileOps(local.platform, async (request) => {
    sent.push(request);
    const body = await executeFileOp(local, fileOpRequestSchema.parse(JSON.parse(JSON.stringify(request))));
    return JSON.parse(JSON.stringify(body));
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('RemoteFileOps over executeFileOp', () => {
  it('carries every operation and returns what the host\'s own file operations return', async () => {
    const file = path.join(dir, 'a.txt');
    const bytes = Buffer.from([0x68, 0x69, 0x00, 0xff, 0x0a]);

    expect(await remote.create(path.join(dir, 'sub'), 'directory')).toEqual({ created: true });
    const written = await remote.write(file, bytes);
    expect(readFileSync(file).equals(bytes)).toBe(true);
    const read = await remote.read(file);
    expect(read.data.equals(bytes)).toBe(true);
    expect(read.stat).toMatchObject({ kind: 'file', size: 5, mtimeMs: written.mtimeMs });
    expect(await remote.stat(file)).toEqual(read.stat);
    expect(await remote.stat(path.join(dir, 'missing'))).toBeNull();
    expect((await remote.list(dir)).map((e) => e.name).sort()).toEqual(['a.txt', 'sub']);
    expect(await remote.realpath(file)).toBe(file);
    await remote.rename(file, path.join(dir, 'b.txt'));
    await remote.remove(path.join(dir, 'b.txt'));
    expect((await remote.list(dir)).map((e) => e.name)).toEqual(['sub']);
  });

  it('carries mtimeMs in a listing and a head read, which is not limited by the size of the file', async () => {
    const file = path.join(dir, 'rollout.jsonl');
    writeFileSync(file, 'head line\nthe rest of a file\n');
    const listed = (await remote.list(dir)).find((e) => e.name === 'rollout.jsonl');
    expect(listed?.mtimeMs).toBe((await remote.stat(file))?.mtimeMs);
    const head = await remote.read(file, { headBytes: 9 });
    expect(head.data.toString()).toBe('head line');
    expect(head.stat.size).toBe(29);
    expect(sent.at(-1)).toMatchObject({ op: 'read', headBytes: 9 });
  });

  it('carries a walk, a directory replacement and the age of an entry in one request each', async () => {
    mkdirSync(path.join(dir, 'staging'));
    writeFileSync(path.join(dir, 'staging', 'new.txt'), 'n');
    mkdirSync(path.join(dir, 'target'));
    writeFileSync(path.join(dir, 'target', 'old.txt'), 'o');

    await remote.replaceDirectory(path.join(dir, 'staging'), path.join(dir, 'target'));
    const walked = await remote.walk(dir, { excludeNames: ['x'], maxEntries: 10, maxDepth: 3, timeBudgetMs: 5_000 });

    expect(walked.truncated).toBe(false);
    expect(walked.entries.map((e) => e.path)).toEqual(['target/new.txt']);
    expect((await remote.stat(path.join(dir, 'target'), { withAge: true }))?.ageMs).toBeGreaterThanOrEqual(0);
    expect((await remote.stat(path.join(dir, 'target')))?.ageMs).toBeUndefined();
    expect(sent.filter((r) => r.op === 'walk' || r.op === 'replaceDirectory')).toHaveLength(2);
  });

  it('rethrows a refusal of the host as the same error with its details', async () => {
    const file = path.join(dir, 'a.txt');
    writeFileSync(file, 'v1');
    const err = await remote.write(file, Buffer.from('v2'), { expect: { mtimeMs: 1 } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileOpsError);
    expect(err).toMatchObject({ code: 'CONFLICT', details: { currentMtimeMs: expect.any(Number) } });

    const big = await remote.read(file, { maxBytes: 1 }).catch((e: unknown) => e);
    expect(big).toMatchObject({ code: 'TOO_LARGE', details: { size: 2 } });

    const missing = await remote.read(path.join(dir, 'missing')).catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: 'NOT_FOUND' });

    const invalid = await remote.stat(`${dir}\0x`).catch((e: unknown) => e);
    expect(invalid).toMatchObject({ code: 'INVALID_PATH' });
  });

  it('sends the optimistic lock to the host, which checks it', async () => {
    const file = path.join(dir, 'a.txt');
    writeFileSync(file, 'v1');
    await remote.write(file, Buffer.from('v2'), { expect: { sha256: 'a'.repeat(64) } }).catch(() => undefined);
    expect(readFileSync(file, 'utf8')).toBe('v1');
    expect(sent[0]).toMatchObject({ op: 'write', expect: { sha256: 'a'.repeat(64) } });
  });

  it('does not accept a response of a shape it does not know', async () => {
    const broken = new RemoteFileOps('linux', async () => ({ ok: true, result: { entries: [] } }));
    await expect(broken.list('/x')).rejects.toThrow();
    const garbage = new RemoteFileOps('linux', async () => 'not an object');
    await expect(garbage.list('/x')).rejects.toThrow();
  });
});

describe('fileOpRequestSchema', () => {
  it('accepts each operation and rejects one it does not know', () => {
    expect(fileOpRequestSchema.safeParse({ op: 'list', path: '/x' }).success).toBe(true);
    expect(fileOpRequestSchema.safeParse({ op: 'rename', from: '/a', to: '/b' }).success).toBe(true);
    expect(fileOpRequestSchema.safeParse({ op: 'exec', command: 'id' }).success).toBe(false);
  });

  it('rejects an empty path, a missing field and a wrong type', () => {
    expect(fileOpRequestSchema.safeParse({ op: 'stat', path: '' }).success).toBe(false);
    expect(fileOpRequestSchema.safeParse({ op: 'rename', from: '/a' }).success).toBe(false);
    expect(fileOpRequestSchema.safeParse({ op: 'create', path: '/a', kind: 'symlink' }).success).toBe(false);
    expect(fileOpRequestSchema.safeParse({ op: 'write', path: '/a', dataBase64: 5 }).success).toBe(false);
  });

  it('bounds a walk', () => {
    const walk = { op: 'walk', path: '/a', excludeNames: [], maxEntries: 10, timeBudgetMs: 1000 };
    expect(fileOpRequestSchema.safeParse(walk).success).toBe(true);
    expect(fileOpRequestSchema.safeParse({ ...walk, maxEntries: 0 }).success).toBe(false);
    expect(fileOpRequestSchema.safeParse({ ...walk, maxEntries: MAX_WALK_ENTRIES + 1 }).success).toBe(false);
    expect(fileOpRequestSchema.safeParse({ ...walk, timeBudgetMs: MAX_WALK_TIME_BUDGET_MS + 1 }).success).toBe(false);
    expect(fileOpRequestSchema.safeParse({ ...walk, excludeNames: undefined }).success).toBe(false);
  });

  it('bounds a read and refuses a malformed hash', () => {
    expect(fileOpRequestSchema.safeParse({ op: 'read', path: '/a', maxBytes: MAX_FILE_OPS_BYTES + 1 }).success).toBe(false);
    expect(fileOpRequestSchema.safeParse({ op: 'read', path: '/a', maxBytes: 0 }).success).toBe(false);
    expect(fileOpRequestSchema.safeParse({ op: 'read', path: '/a', headBytes: MAX_FILE_OPS_BYTES + 1 }).success).toBe(false);
    expect(fileOpRequestSchema.safeParse({ op: 'read', path: '/a', headBytes: 100 }).success).toBe(true);
    expect(fileOpRequestSchema.safeParse({ op: 'write', path: '/a', dataBase64: '', expect: { sha256: 'xyz' } }).success).toBe(false);
  });
});

describe('executeFileOp', () => {
  it('bounds what a read returns even when the request names no limit', async () => {
    mkdirSync(path.join(dir, 'd'));
    writeFileSync(path.join(dir, 'small'), 'x');
    const response = await executeFileOp(local, { op: 'read', path: path.join(dir, 'small') });
    expect(response).toMatchObject({ ok: true });
  });

  it('lets an unexpected error propagate instead of turning it into a body', async () => {
    const broken = { ...local, platform: local.platform, list: async () => { throw new TypeError('boom'); } } as unknown as LocalFileOps;
    await expect(executeFileOp(broken, { op: 'list', path: '/x' })).rejects.toThrow('boom');
  });
});
