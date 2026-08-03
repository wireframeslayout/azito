import { describe, it, expect } from 'vitest';
import { MinioStorageClient } from './MinioStorageClient';

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
