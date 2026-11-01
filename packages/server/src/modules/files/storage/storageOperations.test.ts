import { describe, expect, it, vi } from 'vitest';
import { CopyObjectCommand, DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { StorageOperations, validateStoragePath } from './storageOperations';
import type { StorageSettings } from './MinioStorageClient';

const settings: StorageSettings = { endpoint: 'http://localhost', accessKey: 'key', secretKey: 'secret', bucket: 'bucket', region: 'us-east-1', maxFileSize: 100, useSsl: false };

describe('storage operations', () => {
  it('rejects paths that escape the project and malformed folders', () => {
    for (const path of ['../x', '/x', 'x//y', 'x\\y', 'x/./y', 'x\u0000y']) expect(() => validateStoragePath(path, false)).toThrow();
    expect(() => validateStoragePath('', true)).toThrow();
    expect(validateStoragePath('', true, true)).toBe('');
  });
  it('copies every object before deleting sources', async () => {
    const commands: unknown[] = [];
    const send = vi.fn(async (command: unknown) => {
      commands.push(command);
      if (command instanceof ListObjectsV2Command) return command.input.Prefix === 'projects/1/source/' ? { Contents: [{ Key: 'projects/1/source/a' }, { Key: 'projects/1/source/b' }] } : {};
      if (command instanceof HeadObjectCommand) throw Object.assign(new Error('missing'), { name: 'NotFound' });
      return {};
    });
    const ops = new StorageOperations({ send } as unknown as S3Client, settings, 1);
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
    const ops = new StorageOperations({ send } as unknown as S3Client, settings, 1);
    await expect(ops.moveObjects(['source/'], 'target/')).rejects.toThrow('copy failed');
    const deletion = send.mock.calls.map(([command]) => command).find((command) => command instanceof DeleteObjectsCommand) as DeleteObjectsCommand;
    expect(deletion.input.Delete?.Objects).toEqual([{ Key: 'projects/1/target/source/a' }]);
  });
});
