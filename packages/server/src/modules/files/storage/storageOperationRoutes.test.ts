import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import storageRoutes, { type StorageRouteOptions } from '../routes';
import { StorageOperationError } from './storageOperations';

describe('storage operation routes', () => {
  it('creates a bucket and safely classifies errors', async () => {
    const createBucket = vi.fn(async () => {});
    const app = Fastify();
    await app.register(storageRoutes, {
      projectRepo: { findById: (id: number) => id === 1 ? { id } : null },
      storageSettingsRepo: { get: () => ({}) }, storageClient: {},
      storageStatusService: { createBucket },
    } as unknown as StorageRouteOptions);
    try {
      expect((await app.inject({ method: 'POST', url: '/api/projects/2/storage/bucket' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: '/api/projects/1/storage/bucket' })).json()).toEqual({ ok: true });
      createBucket.mockRejectedValueOnce(Object.assign(new Error('secret'), { name: 'AccessDenied' }));
      const response = await app.inject({ method: 'POST', url: '/api/projects/1/storage/bucket' });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ code: 'auth', error: 'Storage authentication failed.' });
    } finally { await app.close(); }
  });
  it('validates project keys and returns the latest content on a conflict', async () => {
    const text = { read: vi.fn(async () => ({ content: 'latest', etag: 'v2', language: 'text', size: 6 })), write: vi.fn(async () => { throw new StorageOperationError(409, 'conflict', 'File has changed'); }) };
    const app = Fastify();
    await app.register(storageRoutes, {
      projectRepo: { findById: (id: number) => id === 1 ? { id } : null },
      storageSettingsRepo: { get: () => ({}) }, storageClient: { textContent: () => text },
      storageStatusService: {},
    } as unknown as StorageRouteOptions);
    try {
      const root = '/api/projects/1/storage/content';
      expect((await app.inject({ method: 'GET', url: root + '?key=projects%2F2%2Ffile' })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: root + '?key=projects%2F1%2Ffile' })).json()).toEqual({ content: 'latest', etag: 'v2', language: 'text', size: 6 });
      expect((await app.inject({ method: 'PUT', url: root, payload: { key: 'projects/1/file', content: 'edit' } })).statusCode).toBe(400);
      const response = await app.inject({ method: 'PUT', url: root, payload: { key: 'projects/1/file', content: 'edit', baseEtag: 'v1' } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'conflict', content: 'latest', etag: 'v2' });
      expect(text.write).toHaveBeenCalledWith('file', 'edit', 'v1');

      text.read.mockRejectedValueOnce(new StorageOperationError(400, 'binary', 'File contains NUL bytes'));
      const binary = await app.inject({ method: 'PUT', url: root, payload: { key: 'projects/1/file', content: 'edit', baseEtag: 'v1' } });
      expect(binary.json()).toEqual({ error: 'conflict', latest: { error: 'File contains NUL bytes', code: 'binary' } });

      text.read.mockRejectedValueOnce(new StorageOperationError(404, 'not_found', 'File not found'));
      const deleted = await app.inject({ method: 'PUT', url: root, payload: { key: 'projects/1/file', content: 'edit', baseEtag: 'v1' } });
      expect(deleted.json()).toEqual({ error: 'conflict', latest: null });
    } finally { await app.close(); }
  });
  it('uses the documented contracts and enforces project boundaries', async () => {
    const operations = {
      listPage: vi.fn(async () => ({ prefix: 'a/', folders: [], files: [], nextCursor: null })),
      createFolder: vi.fn(async () => {}), renameFolder: vi.fn(async () => {}), renameFile: vi.fn(async () => {}),
      moveObjects: vi.fn(async () => {}), deletePaths: vi.fn(async () => {}), statPrefix: vi.fn(async () => ({ count: 2, totalSize: 12 })),
    };
    const app = Fastify();
    const opts = {
      projectRepo: { findById: (id: number) => id === 1 ? { id } : null },
      storageSettingsRepo: { get: () => ({}) }, storageClient: { operations: () => operations },
      storageStatusService: { getStatus: async () => ({ status: 'ready' }) },
    } as unknown as StorageRouteOptions;
    await app.register(storageRoutes, opts);
    const root = '/api/projects/1/storage';
    try {
      expect((await app.inject({ method: 'GET', url: '/api/projects/2/storage/entries' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `${root}/entries?limit=0` })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: `${root}/entries?prefix=a%2F` })).json()).toEqual({ prefix: 'a/', folders: [], files: [], nextCursor: null });
      expect(operations.listPage).toHaveBeenCalledWith('a/', 200, undefined);
      expect((await app.inject({ method: 'POST', url: `${root}/folders`, payload: { prefix: 'a/' } })).statusCode).toBe(200);
      expect(operations.createFolder).toHaveBeenCalledWith('a/');
      expect((await app.inject({ method: 'PATCH', url: `${root}/entries`, payload: { key: 'projects/1/a/file', displayName: 'new' } })).statusCode).toBe(200);
      expect(operations.renameFile).toHaveBeenCalledWith('a/file', 'new');
      expect((await app.inject({ method: 'PATCH', url: `${root}/entries`, payload: { prefix: 'a/', newName: 'b' } })).statusCode).toBe(200);
      expect(operations.renameFolder).toHaveBeenCalledWith('a/', 'b');
      expect((await app.inject({ method: 'POST', url: `${root}/move`, payload: { keys: ['projects/1/a/file'], prefixes: ['b/'], destPrefix: 'c/' } })).statusCode).toBe(200);
      expect(operations.moveObjects).toHaveBeenCalledWith(['a/file', 'b/'], 'c/');
      expect((await app.inject({ method: 'POST', url: `${root}/delete`, payload: { keys: ['projects/1/a/file'], prefixes: ['b/'] } })).statusCode).toBe(200);
      expect(operations.deletePaths).toHaveBeenCalledWith(['a/file', 'b/']);
      expect((await app.inject({ method: 'GET', url: `${root}/stat?prefix=a%2F` })).json()).toEqual({ count: 2, totalSize: 12 });
      for (const key of ['projects/2/file', 'projects/1/../file', 'projects/1/a//file']) {
        expect((await app.inject({ method: 'POST', url: `${root}/delete`, payload: { keys: [key], prefixes: [] } })).statusCode).toBe(400);
      }
      operations.createFolder.mockRejectedValueOnce(new StorageOperationError(409, 'exists', 'Folder already exists'));
      const conflict = await app.inject({ method: 'POST', url: `${root}/folders`, payload: { prefix: 'a/' } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({ error: 'Folder already exists', code: 'exists' });
    } finally { await app.close(); }
  });
});
