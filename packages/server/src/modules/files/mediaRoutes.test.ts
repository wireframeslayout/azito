import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerMediaRoutes } from './mediaRoutes';
import { MediaService } from './mediaService';

function service(): MediaService {
  const value = {
    parse: vi.fn((token: string) => token === 'valid' ? { kind: 'server', server: 'local', projectId: 1, path: '/project/file.mp4' } : null),
    validate: vi.fn(async () => '/project/file.mp4'),
    serverFile: vi.fn(async () => ({ buffer: Buffer.from('0123456789'), contentType: 'video/mp4', basename: 'file.mp4' })),
  };
  return value as unknown as MediaService;
}

describe('media routes', () => {
  it('serves partial ranges and refuses invalid tokens or ranges', async () => {
    const app = Fastify();
    const mock = service();
    registerMediaRoutes(app, mock);
    const partial = await app.inject({ url: '/api/media/valid', headers: { range: 'bytes=2-4' } });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers['content-range']).toBe('bytes 2-4/10');
    expect(partial.body).toBe('234');
    expect(mock.serverFile).toHaveBeenCalledWith(expect.objectContaining({ path: '/project/file.mp4' }), '/project/file.mp4');
    expect((await app.inject({ url: '/api/media/valid', headers: { range: 'bytes=10-' } })).statusCode).toBe(416);
    expect((await app.inject({ url: '/api/media/bad' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/media/valid', headers: { range: 'bytes=0-1,3-4' } })).statusCode).toBe(200);
    await app.close();
  });
  it('accepts tokens longer than Fastify\'s ordinary parameter limit', async () => {
    const app = Fastify();
    const mock = service();
    vi.mocked(mock.parse).mockReturnValue({ kind: 'server', server: 'local', projectId: 1, path: '/project/file.mp4' });
    registerMediaRoutes(app, mock);
    expect((await app.inject({ url: `/api/media/${'x'.repeat(500)}` })).statusCode).toBe(200);
    await app.close();
  });
});
