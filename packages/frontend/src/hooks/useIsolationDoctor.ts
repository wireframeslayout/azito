import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { useToast } from './useToast';

// Issue #29 Step 2 C: drives POST /api/servers/:name/isolation/doctor from
// the server detail page's Overview section. Kept as its own hook (mirrors
// useServerEditForm's separation from useServerDetail) since it owns a
// distinct concern — a fire-and-refresh mutation with its own loading state
// — rather than being folded into useServerDetail's read-only fetch.
export function useIsolationDoctor(serverName: string | null, onDone: () => void) {
  const [running, setRunning] = useState(false);
  const { showToast } = useToast();
  const { t } = useTranslation('servers');

  const runDoctor = useCallback(async () => {
    if (!serverName || running) return;
    setRunning(true);
    try {
      const res = await api<{ error?: string; message?: string }>(
        `/servers/${encodeURIComponent(serverName)}/isolation/doctor`,
        { method: 'POST' },
      );
      if (res.error) {
        showToast(t('overview.isolationDoctorFailedToast', { error: res.message ?? res.error }));
        return;
      }
      onDone();
    } catch (err: unknown) {
      showToast(t('overview.isolationDoctorFailedToast', { error: (err as Error).message }));
    } finally {
      setRunning(false);
    }
  }, [serverName, running, showToast, t, onDone]);

  return { running, runDoctor };
}
