import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerFilesBackend } from './ServerFilesBackend';
import { StorageFilesBackend } from './StorageFilesBackend';

vi.mock('../../../api/token', () => ({ getUiToken: () => null, clearUiToken: () => {} }));

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('ServerFilesBackend', () => {
  it('keeps both version fields and reads the latest content after conflict', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ content: 'old', language: 'text', mtime: 1, hash: 'a' }))
      .mockResolvedValueOnce(response({ error: 'conflict' }, 409))
      .mockResolvedValueOnce(response({ content: 'new', language: 'text', mtime: 2, hash: 'b' }));
    vi.stubGlobal('fetch', fetchMock);
    const backend = new ServerFilesBackend('host', 1);
    const read = await backend.read('/a');
    if (read.kind !== 'text') throw new Error('expected text');
    expect(await backend.save('/a', 'mine', read.version, false)).toEqual({ kind: 'conflict', latest: { kind: 'text', content: 'new', language: 'text', version: JSON.stringify({ mtime: 2, hash: 'b' }) } });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ baseMtime: 1, baseHash: 'a' });
  });
  it('saves forcibly without sending base fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ mtime: 2, hash: 'b' }));
    vi.stubGlobal('fetch', fetchMock);
    await new ServerFilesBackend('host', 1).save('/a', 'edited', JSON.stringify({ mtime: 1, hash: 'a' }), true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.force).toBe(true);
    expect(body).not.toHaveProperty('baseMtime');
    expect(body).not.toHaveProperty('baseHash');
  });

});

describe('StorageFilesBackend', () => {
  it('fetches one page and preserves the cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ folders: [{ name: 'sub', prefix: 'dir/sub/' }], files: [{ key: 'projects/1/dir/a', displayName: 'a', size: 3, lastModified: '2026-01-01T00:00:00.000Z' }], nextCursor: 'more' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await new StorageFilesBackend(1).listPage('dir/', 'first')).toEqual({ entries: [{ name: 'sub', type: 'directory', path: 'dir/sub/' }, { name: 'a', type: 'file', path: 'dir/a', size: 3, lastModified: '2026-01-01T00:00:00.000Z' }], nextCursor: 'more' });
    expect(fetchMock.mock.calls[0][0]).toContain('prefix=dir%2F&cursor=first');
  });
  it('sends multiple relative paths in one request and reads folder statistics', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ count: 2, totalSize: 17 })).mockImplementation(async () => response({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const backend = new StorageFilesBackend(1);
    expect(await backend.stat('dir/')).toEqual({ count: 2, totalSize: 17 });
    const selection = [{ name: 'a', type: 'file' as const, path: 'a' }, { name: 'dir', type: 'directory' as const, path: 'dir/' }];
    await backend.deleteMany(selection);
    await backend.moveMany(selection, 'destination/');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ keys: ['projects/1/a'], prefixes: ['dir/'] });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ keys: ['projects/1/a'], prefixes: ['dir/'], destPrefix: 'destination/' });
  });
  it('lists every page and maps keys and prefixes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ folders: [{ name: 'dir', prefix: 'dir/' }], files: [], nextCursor: 'next' })).mockResolvedValueOnce(response({ folders: [], files: [{ key: 'projects/1/a', displayName: 'a', size: 3 }], nextCursor: null })));
    expect(await new StorageFilesBackend(1).list('')).toEqual([{ name: 'dir', type: 'directory', path: 'dir/' }, { name: 'a', type: 'file', path: 'a', size: 3 }]);
  });
  it('sends operations with the storage API selection format', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => response({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const backend = new StorageFilesBackend(1);
    await backend.rename('a', 'b');
    await backend.move('a', 'file', 'dir/');
    await backend.delete('dir/', 'directory');
    await backend.create('new/', 'directory');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ key: 'projects/1/a', displayName: 'b' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ keys: ['projects/1/a'], prefixes: [], destPrefix: 'dir/' });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ keys: [], prefixes: ['dir/'] });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ prefix: 'new/' });
  });
  it('accepts a folder conflict only after confirming the exact folder exists', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ error: 'Folder already exists', code: 'exists' }, 409))
      .mockResolvedValueOnce(response({ folders: [], files: [], nextCursor: 'next' }))
      .mockResolvedValueOnce(response({ folders: [{ name: 'sub', prefix: 'dir/sub/' }], files: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new StorageFilesBackend(1).ensureFolder('dir/sub/')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[1][0]).toContain('prefix=dir%2F');
    expect(fetchMock.mock.calls[2][0]).toContain('cursor=next');
  });
  it('reports unconfirmed conflicts and other folder creation failures', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ error: 'Folder already exists', code: 'exists' }, 409))
      .mockResolvedValueOnce(response({ folders: [], files: [], nextCursor: null }))
      .mockResolvedValueOnce(response({ error: 'Access denied', code: 'forbidden' }, 403));
    vi.stubGlobal('fetch', fetchMock);
    const backend = new StorageFilesBackend(1);
    await expect(backend.ensureFolder('missing/')).rejects.toThrow('Folder already exists');
    await expect(backend.ensureFolder('denied/')).rejects.toThrow('Access denied');
  });
  it('creates a file through upload and returns its opaque key', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => response({ file: { key: 'projects/1/dir/123_a.txt' } }));
    vi.stubGlobal('fetch', fetchMock);
    const key = await new StorageFilesBackend(1).create('dir/a.txt', 'file');
    expect(key).toBe('dir/123_a.txt');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/1/storage/upload?prefix=dir%2F');
  });
  it('returns the latest text on conflict and surfaces unreadable content', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ error: 'conflict', content: 'new', etag: 'v2' }, 409)).mockResolvedValueOnce(response({ error: 'File exceeds 500 KiB', code: 'too_large' }, 413));
    vi.stubGlobal('fetch', fetchMock);
    const backend = new StorageFilesBackend(1);
    expect(await backend.save('a', 'mine', 'v1', false)).toEqual({ kind: 'conflict', latest: { kind: 'text', content: 'new', language: 'text', version: 'v2' } });
    expect(await backend.read('a')).toEqual({ kind: 'unavailable', code: 'too_large', message: 'File exceeds 500 KiB' });
  });
  it('maps relative file paths to API keys for reads and writes', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ content: 'x', language: 'text', etag: 'v1', size: 1 })).mockResolvedValueOnce(response({ etag: 'v2' }));
    vi.stubGlobal('fetch', fetchMock);
    const backend = new StorageFilesBackend(1);
    expect(await backend.read('dir/a')).toEqual({ kind: 'text', content: 'x', language: 'text', version: 'v1' });
    await backend.save('dir/a', 'y', 'v1', false);
    expect(fetchMock.mock.calls[0][0]).toContain('key=projects%2F1%2Fdir%2Fa');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ key: 'projects/1/dir/a', content: 'y', baseEtag: 'v1', force: false });
  });
  it('explains a conflict whose latest version is no longer editable text', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ error: 'conflict', latest: { error: 'File contains NUL bytes', code: 'binary' } }, 409))
      .mockResolvedValueOnce(response({ error: 'conflict', latest: null }, 409)));
    const backend = new StorageFilesBackend(1);
    expect(await backend.save('a', 'mine', 'v1', false)).toEqual({ kind: 'conflict', latest: { kind: 'unavailable', code: 'binary', message: 'File contains NUL bytes' } });
    expect(await backend.save('a', 'mine', 'v1', false)).toEqual({ kind: 'conflict', latest: null });
  });
});

describe('unreadable text', () => {
  it('keeps the server code and treats an unexplained answer as a load error', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ error: 'File is not valid UTF-8', code: 'invalid_utf8' }, 400))
      .mockResolvedValueOnce(response({ error: 'Invalid path' }, 400))
      .mockResolvedValueOnce(response({ error: 'EACCES' }, 403)));
    const backend = new ServerFilesBackend('host', 1);
    expect(await backend.read('/a')).toEqual({ kind: 'unavailable', code: 'invalid_utf8', message: 'File is not valid UTF-8' });
    await expect(backend.read('/b')).rejects.toThrow('Invalid path');
    expect(await backend.read('/c')).toEqual({ kind: 'unavailable', code: 'forbidden', message: 'EACCES' });
  });
});
