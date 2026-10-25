import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { Server } from '../../../hooks/useServerManagement';
import { Button } from '../../ui';
import { useToast } from '../../../hooks/useToast';
import { useServerDeletion } from '../../../hooks/useServerDeletion';
import { DeleteServerPanel } from './DeleteServerPanel';

interface DangerSectionProps {
  server: Server;
  onDeleted: () => void;
}

export default function DangerSection({ server, onDeleted }: DangerSectionProps) {
  const { t } = useTranslation('servers');
  const deletion = useServerDeletion(server, onDeleted);
  const [confirmingFp, setConfirmingFp] = useState(false);
  const [resettingFp, setResettingFp] = useState(false);
  const { showToast } = useToast();

  const handleResetFingerprint = useCallback(async () => {
    setResettingFp(true);
    try {
      await api(`/servers/${encodeURIComponent(server.name)}/ssh-fingerprint`, { method: 'DELETE' });
    } catch (err: unknown) {
      showToast(`Reset failed: ${(err as Error).message}`);
    } finally {
      setResettingFp(false);
      setConfirmingFp(false);
    }
  }, [server.name, showToast]);

  return (
    <div>
      <h3 style={{
        fontFamily: 'var(--mono)',
        fontSize: 'var(--font-xs)',
        letterSpacing: '.12em',
        textTransform: 'uppercase',
        color: 'var(--danger)',
        borderBottom: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)',
        paddingBottom: 6,
        marginBottom: 16,
        marginTop: 0,
      }}>
        {t('sections.danger')}
      </h3>

      {server.type === 'agent' && (
        <div style={{
          border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--space-4)',
          marginBottom: 'var(--space-4)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600, color: 'var(--text)' }}>
                {t('danger.resetFingerprint')}
              </div>
              <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginTop: 4 }}>
                {t('danger.resetFingerprintDesc')}
              </div>
            </div>
            {!confirmingFp ? (
              <Button
                variant="danger"
                onClick={() => setConfirmingFp(true)}
              >
                {t('danger.resetFingerprint')}
              </Button>
            ) : (
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Button onClick={() => setConfirmingFp(false)}>{t('common:actions.cancel')}</Button>
                <Button
                  variant="danger"
                  onClick={handleResetFingerprint}
                  loading={resettingFp}
                  loadingLabel={t('danger.resetting')}
                >
                  {t('common:actions.confirm')}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{
        border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-4)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600, color: 'var(--text)' }}>
              {t('danger.deleteServer')}
            </div>
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginTop: 4 }}>
              {t('danger.deleteServerDesc')}
            </div>
          </div>
          {deletion.phase === 'idle' && (
            <Button
              variant="danger"
              onClick={deletion.open}
            >
              {t('common:actions.delete')}
            </Button>
          )}
        </div>
        {deletion.phase !== 'idle' && (
          <div style={{ marginTop: 'var(--space-4)' }}>
            <DeleteServerPanel deletion={deletion} />
          </div>
        )}
      </div>
    </div>
  );
}
