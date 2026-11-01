import { describe, expect, it, vi } from 'vitest';
import { CopyObjectCommand, DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { StorageOperations, validateStoragePath } from './storageOperations';

const bucket = 'bucket';

describe('storage operations', () => {
  it('rejects paths that escape the project and malformed folders', () => {
    for (const path of ['../x', '/x', 'x//y', 'x\\y', 'x/./y', 'x\u0000y']) expect(() => validateStoragePath(path, false)).toThrow();
    expect(() => validateStoragePath('', true)).toThrow();
    expect(validateStoragePath('', true, true)).toBe('');
  });
  it('lists display metadata and pages statistics', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) return { Metadata: { 'display-name': encodeURIComponent('日本語.txt') }, ContentType: 'text/plain' };
      if (command instanceof ListObjectsV2Command && command.input.Delimiter) return {
        CommonPrefixes: [{ Prefix: 'projects/1/a/folder/' }],
        Contents: [{ Key: 'projects/1/a/123_file', Size: 5, ETag: 'etag', LastModified: new Date('2024-01-01T00:00:00Z') }], NextContinuationToken: 'next',
      };
      if (command instanceof ListObjectsV2Command && !command.input.ContinuationToken) return { Contents: [{ Key: 'projects/1/a/x', Size: 5 }], IsTruncated: true, NextContinuationToken: 'next' };
      return { Contents: [{ Key: 'projects/1/a/y', Size: 7 }] };
    });
    const ops = new StorageOperations({ send } as unknown as S3Client, bucket, 1);
    expect(await ops.listPage('a/', 200)).toEqual({ prefix: 'a/', folders: [{ name: 'folder', prefix: 'a/folder/' }], files: [{ key: 'projects/1/a/123_file', displayName: '日本語.txt', size: 5, lastModified: '2024-01-01T00:00:00.000Z', etag: 'etag' }], nextCursor: 'next' });
    expect(await ops.statPrefix('a/')).toEqual({ count: 2, totalSize: 12 });
    await ops.renameFile('a/123_file', '変更.txt');
    const copy = send.mock.calls.map(([command]) => command).find((command) => command instanceof CopyObjectCommand) as CopyObjectCommand;
    expect(copy.input.Metadata?.['display-name']).toBe(encodeURIComponent('変更.txt'));
    expect(copy.input.ContentType).toBe('text/plain');
  });
  it('skips objects deleted while a page is listed', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) throw Object.assign(new Error('missing'), { name: 'NotFound' });
      return { Contents: [{ Key: 'projects/1/gone', Size: 1 }] };
    });
    const ops = new StorageOperations({ send } as unknown as S3Client, bucket, 1);
    expect((await ops.listPage('', 200)).files).toEqual([]);
  });
  it('reports sources left behind after a completed copy as a partial failure', async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof ListObjectsV2Command) return command.input.Prefix === 'projects/1/source/' ? { Contents: [{ Key: 'projects/1/source/a' }] } : {};
      if (command instanceof HeadObjectCommand) throw Object.assign(new Error('missing'), { name: 'NotFound' });
      if (command instanceof DeleteObjectsCommand) return { Errors: [{ Key: 'projects/1/source/a' }] };
      return {};
    });
    const ops = new StorageOperations({ send } as unknown as S3Client, bucket, 1);
    await expect(ops.moveObjects(['source/'], 'target/')).rejects.toMatchObject({ status: 502, code: 'partial_failure' });
  });
  it('copies every object before deleting sources', async () => {
    const commands: unknown[] = [];
    const send = vi.fn(async (command: unknown) => {
      commands.push(command);
      if (command instanceof ListObjectsV2Command) return command.input.Prefix === 'projects/1/source/' ? { Contents: [{ Key: 'projects/1/source/a' }, { Key: 'projects/1/source/b' }] } : {};
      if (command instanceof HeadObjectCommand) throw Object.assign(new Error('missing'), { name: 'NotFound' });
      return {};
    });
    const ops = new StorageOperations({ send } as unknown as S3Client, bucket, 1);
    await ops.moveObjects(['source/'], 'target/');
    expect(commands.filter((c) => c instanceof CopyObjectCommand)).toHaveLength(2);
    expect(commands.at(-1)).toBeInstanceOf(DeleteObjectsCommand);
  });
  it('cleans copied destinations when a copy fails', async () => {
    let copies = 0;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof ListObjectsV2Command) return command.input.Prefix === 'projects/1/source/' ? { Contents: [{ Key: 'projects/1/source/a' }, { Key: 'projects/1/source/b' }] } : {};
      if (command instanceof HeadObjectCommand) throw Object.assign(new Error('missing'), { name: 'NotFound' });
      if (command instanceof CopyObjectCommand && ++copies === 2) throw new Error('copy failed');
      return {};
    });
    const ops = new StorageOperations({ send } as unknown as S3Client, bucket, 1);
    await expect(ops.moveObjects(['source/'], 'target/')).rejects.toThrow('copy failed');
    const deletion = send.mock.calls.map(([command]) => command).find((command) => command instanceof DeleteObjectsCommand) as DeleteObjectsCommand;
    expect(deletion.input.Delete?.Objects).toEqual([{ Key: 'projects/1/target/source/a' }]);
  });
  it('stops scanning a move as soon as the selection exceeds 1000 objects', async () => {
    const listed: string[] = [];
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix!;
        if (command.input.MaxKeys === 1) return { Contents: [] };
        listed.push(prefix);
        return { Contents: Array.from({ length: 600 }, (_, n) => ({ Key: `${prefix}${n}` })) };
      }
      throw new Error(`unexpected ${String(command)}`);
    });
    const ops = new StorageOperations({ send } as unknown as S3Client, bucket, 1);
    await expect(ops.moveObjects(['a/', 'b/', 'c/'], 'dest/')).rejects.toMatchObject({ status: 413, code: 'folder_too_large' });
    expect(listed).toEqual(['projects/1/a/', 'projects/1/b/']);
  });
});
