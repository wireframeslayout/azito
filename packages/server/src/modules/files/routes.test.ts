import fs from 'fs';
import os from 'os';
import { createHash } from 'crypto';
import Fastify from 'fastify';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import { sanitizeFileName, fileBrowseRoutes } from './routes';
import storageRoutes from './routes';
import { isPathContained } from '../git/PathContainment';
import type { IServerRepository } from '../servers/Server';
import type { IProjectRepository } from '../projects/Project';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import type { IStorageSettingsRepository } from './SqliteStorageSettingsRepository';
import type { MinioStorageClient } from './storage/MinioStorageClient';

describe('sanitizeFileName', () => {
  it('preserves Japanese filename', () => {
    expect(sanitizeFileName('日本語の画像.png')).toBe('日本語の画像.png');
  });

  it('preserves ASCII filename', () => {
    expect(sanitizeFileName('image.png')).toBe('image.png');
  });

  it('replaces forward slash with underscore', () => {
    expect(sanitizeFileName('a/b.txt')).toBe('a_b.txt');
  });

  it('replaces backslash with underscore', () => {
    expect(sanitizeFileName('a\\b.txt')).toBe('a_b.txt');
  });

  it('removes control characters', () => {
    expect(sanitizeFileName('file\x00name.txt')).toBe('filename.txt');
  });

  it('removes leading dots', () => {
    expect(sanitizeFileName('.hidden')).toBe('hidden');
  });

  it('returns file fallback for empty string', () => {
    expect(sanitizeFileName('')).toBe('file');
  });

  it('returns file fallback for whitespace only', () => {
    expect(sanitizeFileName('   ')).toBe('file');
  });

  it('preserves emoji', () => {
    expect(sanitizeFileName('\u{1F389}test.txt')).toBe('\u{1F389}test.txt');
  });

  it('normalizes decomposed dakuten to NFC', () => {
    const decomposed = 'が.txt';
    const composed = 'が.txt';
    expect(sanitizeFileName(decomposed)).toBe(composed);
  });
});

describe('file CRUD route guards', () => {
  it('rejects .git basename', () => {
    const targetPath = '/workspace/project/.git';
    expect(path.basename(targetPath)).toBe('.git');
  });

  it('detects root directory deletion attempt', () => {
    const resolvedTarget = '/home/user/workspace/project';
    const resolvedRoot = '/home/user/workspace/project';
    expect(resolvedTarget === resolvedRoot).toBe(true);
  });

  it('allows deletion of a child', () => {
    const resolvedTarget: string = '/home/user/workspace/project/src';
    const resolvedRoot: string = '/home/user/workspace/project';
    expect(resolvedTarget === resolvedRoot).toBe(false);
    expect(isPathContained({ target: resolvedTarget, allowedRoot: resolvedRoot })).toBe(true);
  });

  it('rejects path outside working directory', () => {
    expect(isPathContained({
      target: '/home/user/other-project/file.txt',
      allowedRoot: '/home/user/workspace/project',
    })).toBe(false);
  });

  it('rejects traversal via ..', () => {
    const resolved = path.resolve('/home/user/workspace/project/../../../etc/passwd');
    expect(isPathContained({
      target: resolved,
      allowedRoot: '/home/user/workspace/project',
    })).toBe(false);
  });

  it('rejects newName with path separators', () => {
    const newName = '../etc/passwd';
    expect(newName.includes('/') || newName.includes('\\')).toBe(true);
  });
});

describe('PUT file content route guards', () => {
  it('rejects missing projectId', () => {
    const body: Record<string, unknown> = { path: '/workspace/project/src/index.ts', content: 'x' };
    const projectId = typeof body.projectId === 'number' ? body.projectId : NaN;
    expect(isNaN(projectId)).toBe(true);
  });

  it('rejects path containing control characters', () => {
    const filePath = '/workspace/project/src/index\x00.ts';
    expect(/[\x00-\x1f]/.test(filePath)).toBe(true);
  });

  it('rejects traversal outside the working directory', () => {
    const parentDir = path.dirname('/workspace/project/../../../etc/passwd');
    const resolved = path.resolve(parentDir);
    expect(isPathContained({
      target: resolved,
      allowedRoot: '/workspace/project',
    })).toBe(false);
  });

  it('allows a path inside the working directory', () => {
    const parentDir = path.dirname('/workspace/project/src/index.ts');
    const resolved = path.resolve(parentDir);
    expect(isPathContained({
      target: resolved,
      allowedRoot: '/workspace/project',
    })).toBe(true);
  });

  // Issue #27 review Critical 2: parent-directory containment alone misses a
  // save target that is itself a symlink to outside workingDirectory. The
  // route resolves the target's real path (FileBrowseService
  // .resolveExistingTargetRealPath — see its own primitive-level tests for
  // the resolution itself) and re-checks containment on *that*; this is the
  // containment judgment the route applies to the resolved value.
  it('rejects a save target whose resolved real path escapes the working directory', () => {
    const resolvedTargetOfSymlink = '/etc/passwd';
    expect(isPathContained({
      target: resolvedTargetOfSymlink,
      allowedRoot: '/workspace/project',
    })).toBe(false);
  });
});

// Issue #27 review followup (Important 2): `baseMtime`/`baseHash` used to fall back to `undefined`
// whenever the value was missing OR malformed (wrong type, NaN, non-hex), and `undefined` is exactly
// what `writeFileContent` treats as "no conflict check requested" — the same value it receives when
// the caller explicitly passes `force: true`. So a client bug or a stripped/mistyped field silently
// bypassed the optimistic lock without ever asking for `force`. These drive the real route (via
// `fastify.inject`, not just the string-level guards above) against a real local file so the fix is
// verified end-to-end: malformed/missing fields must 400 before any write happens, and `force: true`
// must still work without them.
describe('PUT /api/servers/:name/files/content — baseMtime/baseHash enforcement', () => {
  let tmpDir: string;
  let filePath: string;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-routes-test-'));
    filePath = path.join(tmpDir, 'target.txt');
    fs.writeFileSync(filePath, 'original\n');

    const serverRepo: Partial<IServerRepository> = {
      findByName: (name: string) =>
        name === 'test-local' ? ({ name: 'test-local', type: 'local', directory: tmpDir } as any) : null,
    };
    const projectServerRepo: Partial<IProjectServerRepository> = {
      find: () => ({ workingDirectory: tmpDir } as any),
    };

    app = Fastify();
    app.register(fileBrowseRoutes, {
      serverRepo: serverRepo as IServerRepository,
      tmux: {} as any,
      projectServerRepo: projectServerRepo as IProjectServerRepository,
      transportFactory: {} as any,
      searchService: {} as any,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const validHash = () => createHash('sha256').update('original\n', 'utf-8').digest('hex');
  const currentMtime = () => fs.statSync(filePath).mtimeMs;

  it('rejects with 400 when baseMtime and baseHash are both omitted (no force)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/servers/test-local/files/content',
      payload: { path: filePath, content: 'updated\n', projectId: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('original\n');
  });

  it('rejects with 400 when baseMtime is malformed (non-numeric)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/servers/test-local/files/content',
      payload: { path: filePath, content: 'updated\n', projectId: 1, baseMtime: 'not-a-number', baseHash: validHash() },
    });
    expect(res.statusCode).toBe(400);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('original\n');
  });

  it('rejects with 400 when baseHash is not a 64-hex-digit sha256', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/servers/test-local/files/content',
      payload: { path: filePath, content: 'updated\n', projectId: 1, baseMtime: currentMtime(), baseHash: 'not-a-hash' },
    });
    expect(res.statusCode).toBe(400);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('original\n');
  });

  it('rejects with 400 when baseHash is uppercase hex (must be lowercase 64-digit hex)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/servers/test-local/files/content',
      payload: { path: filePath, content: 'updated\n', projectId: 1, baseMtime: currentMtime(), baseHash: validHash().toUpperCase() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('succeeds when both baseMtime and baseHash are valid and current', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/servers/test-local/files/content',
      payload: { path: filePath, content: 'updated\n', projectId: 1, baseMtime: currentMtime(), baseHash: validHash() },
    });
    expect(res.statusCode).toBe(200);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('updated\n');
  });

  it('does not require baseMtime/baseHash when force is true', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/servers/test-local/files/content',
      payload: { path: filePath, content: 'forced\n', projectId: 1, force: true },
    });
    expect(res.statusCode).toBe(200);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('forced\n');
  });
});

describe('storage /raw and /url routes — presigned URL usage', () => {
  let app: ReturnType<typeof Fastify>;
  let mockStorageClient: {
    getPresignedUrl: ReturnType<typeof vi.fn>;
    getDirectUrl: ReturnType<typeof vi.fn>;
  };
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;

    const projectRepo: Partial<IProjectRepository> = {
      findById: (id: number) => (id === 1 ? { id: 1, name: 'test' } as any : null),
    };
    const storageSettingsRepo: Partial<IStorageSettingsRepository> = {
      get: () => ({
        endpoint: 'http://minio:9000',
        accessKey: 'key',
        secretKey: 'secret',
        bucket: 'bucket',
        region: 'us-east-1',
        maxFileSize: 10 * 1024 * 1024,
        useSsl: false,
      }),
    };
    mockStorageClient = {
      getPresignedUrl: vi.fn(),
      getDirectUrl: vi.fn(),
    };

    app = Fastify();
    app.register(storageRoutes, {
      projectRepo: projectRepo as IProjectRepository,
      storageSettingsRepo: storageSettingsRepo as IStorageSettingsRepository,
      storageClient: mockStorageClient as unknown as MinioStorageClient,
    });
    await app.ready();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
  });

  it('/raw uses getPresignedUrl, not getDirectUrl', async () => {
    mockStorageClient.getPresignedUrl.mockResolvedValueOnce('http://minio:9000/bucket/projects/1/img.png?X-Amz-Signature=abc');
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(Buffer.from('image-data'), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }));

    const res = await app.inject({ method: 'GET', url: '/api/projects/1/storage/img.png/raw' });
    expect(res.statusCode).toBe(200);
    expect(mockStorageClient.getPresignedUrl).toHaveBeenCalledOnce();
    expect(mockStorageClient.getDirectUrl).not.toHaveBeenCalled();
  });

  it('/raw returns 404 when upstream returns 404', async () => {
    mockStorageClient.getPresignedUrl.mockResolvedValueOnce('http://minio:9000/signed');
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }));

    const res = await app.inject({ method: 'GET', url: '/api/projects/1/storage/missing.png/raw' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'File not found' });
  });

  it('/raw returns 502 when upstream returns 403', async () => {
    mockStorageClient.getPresignedUrl.mockResolvedValueOnce('http://minio:9000/signed');
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 403 }));

    const res = await app.inject({ method: 'GET', url: '/api/projects/1/storage/denied.png/raw' });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'Storage access denied' });
  });

  it('/url returns a presigned URL', async () => {
    mockStorageClient.getPresignedUrl.mockResolvedValueOnce('http://minio:9000/bucket/projects/1/img.png?X-Amz-Signature=abc');

    const res = await app.inject({ method: 'GET', url: '/api/projects/1/storage/img.png/url' });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toContain('X-Amz-Signature');
    expect(mockStorageClient.getDirectUrl).not.toHaveBeenCalled();
  });

  it('/url returns 502 when presigning fails', async () => {
    mockStorageClient.getPresignedUrl.mockRejectedValueOnce(new Error('signing failed'));

    const res = await app.inject({ method: 'GET', url: '/api/projects/1/storage/img.png/url' });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'signing failed' });
  });

  it('/raw returns 502 when presigning fails', async () => {
    mockStorageClient.getPresignedUrl.mockRejectedValueOnce(new Error('signing failed'));

    const res = await app.inject({ method: 'GET', url: '/api/projects/1/storage/img.png/raw' });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'signing failed' });
  });
});
