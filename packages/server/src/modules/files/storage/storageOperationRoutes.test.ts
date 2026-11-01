import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import storageRoutes, { type StorageRouteOptions } from '../routes';
import { StorageOperationError } from './storageOperations';

describe('storage operation routes', () => {
  it('validates input, checks the project, and maps operation errors', async () => {
    const listPage = vi.fn(async () => ({ entries: [], nextCursor: null }));
    const createFolder = vi.fn(async () => { throw new StorageOperationError(409, 'conflict', 'Folder already exists'); });
    const app = Fastify();
    const opts = {
      projectRepo: { findById: (id: number) => id === 1 ? { id } : null },
      storageSettingsRepo: { get: () => ({}) },
      storageClient: { operations: () => ({ listPage, createFolder }) },
      storageStatusService: { getStatus: async () => ({ status: 'ready' }) },
    } as unknown as StorageRouteOptions;
    await app.register(storageRoutes, opts);
    try {
      expect((await app.inject({ method: 'GET', url: '/api/projects/2/storage/entries' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/projects/1/storage/entries?limit=0' })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/api/projects/1/storage/entries?prefix=a%2F' })).statusCode).toBe(200);
      expect(listPage).toHaveBeenCalledWith('a/', 200, undefined);
      const conflict = await app.inject({ method: 'POST', url: '/api/projects/1/storage/folders', payload: { path: 'a/' } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({ error: 'Folder already exists', code: 'conflict' });
    } finally { await app.close(); }
  });
});
