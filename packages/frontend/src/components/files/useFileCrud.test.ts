// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { serverPathApi } from '../../lib/serverPath';
import type { FilesBackend } from './backend/FilesBackend';
import { useFileCrud } from './useFileCrud';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useToast', () => ({ useToast: () => ({ showToast: toast }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('useFileCrud', () => {
  it('shows the backend error when creation fails', async () => {
    const backend: FilesBackend = { source: 'test', read: vi.fn(), save: vi.fn(), list: vi.fn(), create: vi.fn().mockRejectedValue(new Error('permission denied')), rename: vi.fn(), delete: vi.fn(), download: vi.fn() };
    const { result } = renderHook(() => useFileCrud({ backend, rootPath: '/root', pathApi: serverPathApi('linux'), loadRoot: vi.fn(), expandDir: vi.fn(), refreshDir: vi.fn() }));
    await act(async () => { await result.current.startCreate('/root', 'file'); });
    await act(async () => { await result.current.commitCreate('a'); });
    expect(backend.create).toHaveBeenCalledWith('/root/a', 'file');
    expect(toast).toHaveBeenCalledWith('permission denied');
  });
});
