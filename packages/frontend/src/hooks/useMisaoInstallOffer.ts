import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { createWithMisaoInstallOffer } from '../lib/misaoInstallOffer';
import { useConfirm } from './useConfirm';
import { useToast } from './useToast';

/**
 * Wraps a "create in misao" call so that a server without misao offers to install it (after the operator agrees) and
 * retries. `serverName` is the server the call is for.
 */
export function useMisaoInstallOffer(): <T>(serverName: string, create: () => Promise<T>) => Promise<T | { error: string }> {
  const { t } = useTranslation('workspace');
  const confirm = useConfirm();
  const { showToast } = useToast();

  return useCallback((serverName, create) => createWithMisaoInstallOffer(create, {
    confirm: () => confirm({ title: t('misaoInstall.title'), message: t('misaoInstall.message', { server: serverName }), confirmLabel: t('misaoInstall.confirm') }),
    install: () => {
      showToast(t('misaoInstall.installing', { server: serverName }));
      return api(`/servers/${encodeURIComponent(serverName)}/install-misao`, { method: 'POST' });
    },
  }), [confirm, showToast, t]);
}
