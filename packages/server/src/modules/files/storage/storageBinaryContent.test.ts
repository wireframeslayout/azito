import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { StorageBinaryContent } from './storageBinaryContent';

describe('storage binary content', () => {
  function setup(data: Buffer) {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetObjectCommand) return { ETag: '"a"', ContentLength: data.length, Body: Readable.from([data]) };
      if (command instanceof HeadObjectCommand) return { ETag: '"a"', ContentType: 'application/octet-stream' };
      if (command instanceof PutObjectCommand) return { ETag: '"b"' };
      throw new Error('Unexpected command');
    });
    return { client: new StorageBinaryContent({ send } as unknown as S3Client, 'bucket', 1, 20 * 1024 * 1024), send };
  }
  it('returns bytes with their own ETag and writes conditionally', async () => {
    const { client, send } = setup(Buffer.from([0, 255]));
    expect(await client.read('x.xlsx')).toEqual({ data: Buffer.from([0, 255]), etag: 'a' });
    expect(await client.write('x.xlsx', Buffer.from('new'), 'a')).toEqual({ etag: 'b' });
    expect((send.mock.calls[2][0] as PutObjectCommand).input.IfMatch).toBe('"a"');
    await expect(client.write('x.xlsx', Buffer.from('new'), 'old')).rejects.toMatchObject({ code: 'conflict' });
  });
  it('bounds data received even when Content-Length is wrong', async () => {
    const { client, send } = setup(Buffer.alloc(0));
    send.mockResolvedValueOnce({ ETag: '"a"', ContentLength: 1, Body: Readable.from([Buffer.alloc(20 * 1024 * 1024 + 1)]) });
    await expect(client.read('x.xlsx')).rejects.toMatchObject({ code: 'too_large' });
  });
});
