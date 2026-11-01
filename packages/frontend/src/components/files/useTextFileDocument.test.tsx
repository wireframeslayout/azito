// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FilesBackend, FileSaveResult } from './backend/FilesBackend';
import { useTextFileDocument } from './useTextFileDocument';

function backend(save: FilesBackend['save']): FilesBackend {
  return { read: vi.fn(async () => ({ kind: 'text' as const, content: 'base', language: 'text', version: 'v1' })), save, list: vi.fn(), create: vi.fn(), rename: vi.fn(), delete: vi.fn(), download: vi.fn() };
}

describe('useTextFileDocument', () => {
  it('retains edits made while a save is in flight', async () => {
    let finish!: (result: FileSaveResult) => void;
    const save = vi.fn(() => new Promise<FileSaveResult>((resolve) => { finish = resolve; }));
    const backendInstance = backend(save);
    const { result } = renderHook(() => useTextFileDocument(backendInstance, 'file'));
    async function editAndSave() { act(() => result.current.change('first')); await act(async () => { void result.current.save(); }); }
    await waitFor(() => expect(result.current.document).not.toBeNull());
    await editAndSave();
    act(() => result.current.change('second'));
    await act(async () => finish({ kind: 'saved', version: 'v2' }));
    expect(result.current.content).toBe('second');
    expect(result.current.dirty).toBe(true);
    expect(result.current.document?.version).toBe('v2');
  });
  it('preserves edits on a conflict and on save failure', async () => {
    const save = vi.fn<FilesBackend['save']>().mockResolvedValueOnce({ kind: 'conflict', latest: { kind: 'text', content: 'remote', language: 'text', version: 'v2' } }).mockRejectedValueOnce(new Error('offline'));
    const instance = backend(save);
    const { result } = renderHook(() => useTextFileDocument(instance, 'file'));
    await waitFor(() => expect(result.current.document).not.toBeNull());
    act(() => result.current.change('local'));
    await act(async () => { await result.current.save(); });
    expect(result.current.conflict).toMatchObject({ content: 'remote' });
    expect(result.current.content).toBe('local');
    await act(async () => { await result.current.save(true); });
    expect(result.current.error).toBe('offline');
    expect(result.current.content).toBe('local');
    expect(result.current.dirty).toBe(true);
  });

});
