import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'stream';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { StorageTextContent } from './storageTextContent';

function setup(bytes: Buffer) {
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) return { ContentLength: bytes.length, ETag: '"v1"', ContentType: 'text/plain', Metadata: { name: 'test' } };
    if (command instanceof GetObjectCommand) return { Body: Readable.from([bytes]), ETag: '"v1"' };
    if (command instanceof PutObjectCommand) return { ETag: '"v2"' };
    throw new Error('Unexpected command');
  });
  return { send, text: new StorageTextContent({ send } as unknown as S3Client, 'bucket', 1, 1024 * 1024) };
}

describe('storage text content', () => {
  it('reads valid text and preserves its ETag', async () => {
    const { text, send } = setup(Buffer.from('hello'));
    expect(await text.read('a.txt')).toEqual({ content: 'hello', version: 'v1', language: 'text' });
    expect((send.mock.calls[1][0] as GetObjectCommand).input.IfMatch).toBe('"v1"');
  });
  it('rejects binary, invalid UTF-8, oversized and invalid paths', async () => {
    await expect(setup(Buffer.from([0])).text.read('a')).rejects.toMatchObject({ code: 'binary' });
    await expect(setup(Buffer.from([0xff])).text.read('a')).rejects.toMatchObject({ code: 'invalid_utf8' });
    await expect(setup(Buffer.alloc(500 * 1024 + 1)).text.read('a')).rejects.toMatchObject({ code: 'too_large' });
    await expect(setup(Buffer.alloc(0)).text.read('../a')).rejects.toMatchObject({ code: 'invalid_path' });
  });
  it('uses a conditional put and preserves object metadata', async () => {
    const { text, send } = setup(Buffer.from('hello'));
    expect(await text.write('a', 'new', 'v1')).toEqual({ version: 'v2' });
    expect((send.mock.calls[1][0] as PutObjectCommand).input).toMatchObject({ IfMatch: '"v1"', ContentType: 'text/plain', Metadata: { name: 'test' } });
    await expect(text.write('a', 'new', 'old')).rejects.toMatchObject({ code: 'conflict' });
  });
  it('treats a failed conditional PUT as a conflict', async () => {
    const { text, send } = setup(Buffer.from('hello'));
    send.mockImplementationOnce(async () => ({ ContentLength: 5, ETag: '"v1"' })).mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } });
    await expect(text.write('a', 'edit', 'v1')).rejects.toMatchObject({ code: 'conflict' });
  });

});
