import { describe, it, expect, vi } from 'vitest';
import { MinioStorageClient } from './MinioStorageClient';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(),
}));

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const settings = {
  endpoint: 'http://localhost:9000',
  accessKey: 'minioadmin',
  secretKey: 'minioadmin',
  bucket: 'test-bucket',
  region: 'us-east-1',
  maxFileSize: 10 * 1024 * 1024,
  useSsl: false,
};

describe('MinioStorageClient.getDirectUrl', () => {
  const client = new MinioStorageClient();

  it('percent-encodes ASCII filename with spaces', () => {
    const url = client.getDirectUrl(settings, 1, 'my file.txt');
    expect(url).toBe('http://localhost:9000/test-bucket/projects/1/my%20file.txt');
  });

  it('percent-encodes Japanese filename', () => {
    const url = client.getDirectUrl(settings, 1, '日本語.png');
    expect(url).toBe('http://localhost:9000/test-bucket/projects/1/%E6%97%A5%E6%9C%AC%E8%AA%9E.png');
  });

  it('preserves slashes as path separators', () => {
    const url = client.getDirectUrl(settings, 42, 'image.png');
    expect(url).toContain('projects/42/image.png');
  });
});

describe('MinioStorageClient.getPresignedUrl', () => {
  const client = new MinioStorageClient();

  it('returns signed URL on success', async () => {
    vi.mocked(getSignedUrl).mockResolvedValueOnce('http://localhost:9000/test-bucket/projects/1/img.png?X-Amz-Signature=abc');
    const url = await client.getPresignedUrl(settings, 1, 'img.png');
    expect(url).toContain('X-Amz-Signature');
  });

  it('propagates signing errors without falling back to direct URL', async () => {
    vi.mocked(getSignedUrl).mockRejectedValueOnce(new Error('signing failed'));
    await expect(client.getPresignedUrl(settings, 1, 'img.png')).rejects.toThrow('signing failed');
  });
});

describe('MinioStorageClient.list', () => {
  it('lists only root-level files so folder markers stay out of the flat list', async () => {
    const client = new MinioStorageClient();
    const send = vi.fn(async () => ({ Contents: [{ Key: 'projects/1/123_a.txt', Size: 1 }], CommonPrefixes: [{ Prefix: 'projects/1/folder/' }] }));
    vi.spyOn(client as unknown as { getClient: () => unknown }, 'getClient').mockReturnValue({ send });
    const files = await client.list(settings, 1);
    expect((send.mock.calls[0] as unknown[])[0]).toMatchObject({ input: { Prefix: 'projects/1/', Delimiter: '/' } });
    expect(files.map((f) => f.originalName)).toEqual(['a.txt']);
  });
});

describe('MinioStorageClient.probe / ensureBucket', () => {
  function clientWith(send: ReturnType<typeof vi.fn>): MinioStorageClient {
    const client = new MinioStorageClient();
    vi.spyOn(client as unknown as { getClient: () => unknown }, 'getClient').mockReturnValue({ send });
    return client;
  }
  const commandName = (call: unknown[]): string => (call[0] as object).constructor.name;

  it('creates a missing bucket so a fresh MinIO becomes ready', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }))
      .mockResolvedValueOnce({});
    await clientWith(send).probe(settings);
    expect(send.mock.calls.map(commandName)).toEqual(['HeadBucketCommand', 'CreateBucketCommand']);
    expect((send.mock.calls[1] as unknown[])[1]).toMatchObject({ abortSignal: expect.any(AbortSignal) });
  });

  it('does not create a bucket when HeadBucket fails for another reason', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'Forbidden', $metadata: { httpStatusCode: 403 } });
    const send = vi.fn().mockRejectedValueOnce(denied);
    await expect(clientWith(send).ensureBucket(settings)).rejects.toBe(denied);
    expect(send.mock.calls.map(commandName)).toEqual(['HeadBucketCommand']);
  });
});
