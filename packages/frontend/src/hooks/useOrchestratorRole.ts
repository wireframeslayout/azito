import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { apiWithStatus } from '../api/client';
import { paths } from '../paths';
import { useOrchestrators } from './useOrchestrators';
import { useToast } from './useToast';

export type OrchestratorRole = 'orchestrator' | null;

/**
 * Sets or clears a window's orchestrator role and reports it with an undo toast.
 * Clearing the role of the orchestrator on screen leaves its page first, so the page
 * does not report it as "not found" over the undo toast.
 */
export function useOrchestratorRole(onChanged?: () => void): (windowId: number, role: OrchestratorRole) => Promise<void> {
  const { t } = useTranslation('workspace');
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { refresh } = useOrchestrators();
  const { showToast } = useToast();
  const changeRole = useCallback(async (windowId: number, role: OrchestratorRole): Promise<void> => {
    try {
      const response = await apiWithStatus(`/windows/${windowId}/role`, { method: 'PUT', body: JSON.stringify({ role }) });
      if (response.status !== 200) throw new Error('role change failed');
    } catch {
      showToast(t('orchestration.roleError'));
      return;
    }
    if (role === null && pathname === paths.orchestration(windowId)) navigate(paths.orchestration(), { replace: true, state: { missing: true } });
    refresh();
    onChanged?.();
    if (role) window.dispatchEvent(new Event('orchestration:moved'));
    showToast(t(role ? 'orchestration.moved' : 'orchestration.restored'), [
      ...(role ? [{ label: t('orchestration.open'), onClick: () => navigate(paths.orchestration(windowId)) }] : []),
      { label: t('orchestration.undo'), onClick: () => { void changeRole(windowId, role ? null : 'orchestrator'); } },
    ]);
  }, [t, navigate, pathname, refresh, onChanged, showToast]);
  return changeRole;
}
