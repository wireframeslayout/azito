import { describe, expect, it } from 'vitest';
import { MediaService, type MediaDependencies } from './mediaService';

function setup(): MediaService {
  const ops = { realpath: async (path: string) => path, stat: async () => ({ kind: 'file', size: 1 }), platform: 'linux' };
  const deps = {
    key: Buffer.alloc(32, 1),
    projectRepo: { findById: (id: number) => id === 1 ? {} : null },
    projectServerRepo: { find: () => ({ workingDirectory: '/project' }) },
    serverRepo: { findByName: () => ({ name: 'local' }) },
    transportFactory: { getFileOps: () => ops },
    storageSettingsRepo: { get: () => ({}) },
    storageClient: { binaryContent: () => ({ statMedia: async () => ({ size: 1, etag: 'x', contentType: 'video/mp4' }) }) },
  } as unknown as MediaDependencies;
  return new MediaService(deps);
}

describe('media target validation', () => {
  it('scopes storage keys to the requested project', async () => {
    const service = setup();
    await expect(service.issue({ kind: 'storage', projectId: 1, key: 'projects/2/x.mp4' })).rejects.toThrow();
    const url = await service.issue({ kind: 'storage', projectId: 1, key: 'projects/1/x.mp4' });
    expect(service.parse(url.split('/').pop()!)).toEqual({ kind: 'storage', projectId: 1, key: 'projects/1/x.mp4' });
  });
  it('rejects server paths outside the associated project', async () => {
    await expect(setup().validate({ kind: 'server', projectId: 1, server: 'local', path: '/outside/file.mp4' })).rejects.toThrow();
  });
  it('issues a URL for a server file using metadata without reading its content', async () => {
    const service = setup();
    const target = { kind: 'server' as const, projectId: 1, server: 'local', path: '/project/file.mp4' };
    const url = await service.issue(target);
    expect(service.parse(url.split('/').pop()!)).toEqual(target);
  });
});
