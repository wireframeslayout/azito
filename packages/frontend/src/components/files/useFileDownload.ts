import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../hooks/useToast';
import type { FilesBackend } from './backend/FilesBackend';

export async function downloadFile(backend: FilesBackend, path: string, name: string): Promise<void> {
  const url = URL.createObjectURL(await backend.download(path));
  try {
    const link = document.createElement('a');
    link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
  } finally { URL.revokeObjectURL(url); }
}

export function useFileDownload(backend: FilesBackend, path: string, name: string) {
  const { showToast } = useToast();
  const { t } = useTranslation('files');
  return useCallback(async () => {
    try { await downloadFile(backend, path, name); }
    catch { showToast(t('explorer.downloadFailed')); }
  }, [backend, path, name, showToast, t]);
}
