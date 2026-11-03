import { describe, expect, it, vi } from 'vitest';
import { collectStorageDrop, uploadStorageDrop } from './storageDrop';

describe('storage drop', () => {
  it('reads every directory batch and preserves empty folders', async () => {
    const file = new File(['content'], 'a.txt');
    const fileEntry = { name: 'a.txt', isFile: true, isDirectory: false, file: (resolve: (file: File) => void) => resolve(file) };
    const empty = { name: 'empty', isFile: false, isDirectory: true, createReader: () => ({ readEntries: (resolve: (entries: unknown[]) => void) => resolve([]) }) };
    const batches = [[fileEntry], [empty], []];
    const folder = { name: 'folder', isFile: false, isDirectory: true, createReader: () => ({ readEntries: (resolve: (entries: unknown[]) => void) => resolve(batches.shift()!) }) };
    const transfer = { items: [{ kind: 'file', webkitGetAsEntry: () => folder, getAsFile: () => null }] } as unknown as DataTransfer;
    expect(await collectStorageDrop(transfer)).toEqual([
      { type: 'directory', path: 'folder/' },
      { type: 'file', path: 'folder/a.txt', file },
      { type: 'directory', path: 'folder/empty/' },
    ]);
  });

  it('continues after individual failures and reports progress', async () => {
    const file = new File([''], 'a.txt');
    const createFolder = vi.fn().mockRejectedValue(new Error('denied'));
    const uploadFile = vi.fn().mockResolvedValue(undefined);
    const onProgress = vi.fn();
    const result = await uploadStorageDrop([
      { type: 'directory', path: 'dir/' },
      { type: 'file', path: 'dir/a.txt', file },
      { type: 'error', path: 'missing', error: 'unreadable' },
    ], 'current/', { createFolder, uploadFile, onProgress });
    expect(createFolder).toHaveBeenCalledWith('current/dir/');
    expect(uploadFile).toHaveBeenCalledWith(file, 'current/dir/');
    expect(result).toEqual({ completed: 3, total: 3, failures: [{ path: 'dir/', error: 'denied' }, { path: 'missing', error: 'unreadable' }] });
    expect(onProgress.mock.calls).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);
  });
});
