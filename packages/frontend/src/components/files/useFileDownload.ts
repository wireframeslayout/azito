import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../hooks/useToast';
import type { FilesBackend } from './backend/FilesBackend';

export function useFileDownload(backend: FilesBackend, path: string, name: string) {
  const { showToast } = useToast();
  const { t } = useTranslation('files');
  return useCallback(async () => {
    try {
      const url = URL.createObjectURL(await backend.download(path));
      const link = document.createElement('a');
      link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch { showToast(t('explorer.downloadFailed')); }
  }, [backend, path, name, showToast, t]);
}
