import { createContext, useCallback, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../components/Modal';
import { Button, CopyableCommand, DocsLink } from '../components/ui';
import { UninstallStepList } from '../components/servers/UninstallStepList';
import { commandsOf, type UninstallStep } from '../lib/serverDeletion';

interface LeftBehind {
  serverName: string;
  steps: UninstallStep[];
}

type ShowLeftBehind = (serverName: string, steps: UninstallStep[]) => void;

const LeftBehindContext = createContext<ShowLeftBehind | null>(null);

/** Shows what the removal of a server's agent left on its host on purpose (see `leftBehindOf`). Must be called under {@link LeftBehindProvider}. */
export function useLeftBehind(): ShowLeftBehind {
  const ctx = useContext(LeftBehindContext);
  if (!ctx) throw new Error('useLeftBehind must be used within LeftBehindProvider');
  return ctx;
}

/**
 * Mounted once (in Layout), like the confirm dialog: the server's page is gone by the time the person reads this, so the result cannot
 * live in it. A dialog with the steps that were left in place and their reasons, the commands as text that can be copied, and a Close button.
 */
export function LeftBehindProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('servers');
  const [shown, setShown] = useState<LeftBehind | null>(null);
  const show = useCallback<ShowLeftBehind>((serverName, steps) => setShown({ serverName, steps }), []);
  const close = useCallback(() => setShown(null), []);
  const commands = shown === null ? [] : commandsOf(shown.steps);
  return (
    <LeftBehindContext.Provider value={show}>
      {children}
      <Modal
        title={t('danger.leftBehind.title', { name: shown?.serverName ?? '' })}
        open={shown !== null}
        onClose={close}
        maxWidth={560}
        hideCancel
        actions={<Button variant="primary" onClick={close}>{t('common:actions.close')}</Button>}
      >
        <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <p style={{ margin: 0, fontSize: 'var(--font-sm)', color: 'var(--text-dim)', lineHeight: 'var(--leading-body)' }}>{t('danger.leftBehind.intro')}</p>
          {shown !== null && <UninstallStepList steps={shown.steps} />}
          {commands.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              <p style={{ margin: 0, fontSize: 'var(--font-sm)', color: 'var(--text-dim)', lineHeight: 'var(--leading-body)' }}>{t('danger.leftBehind.harmless')}</p>
              <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600 }}>{t('danger.leftBehind.commands')}</div>
              {commands.map((command) => <CopyableCommand key={command} command={command} />)}
            </div>
          )}
          <div style={{ fontSize: 'var(--font-xs)' }}><DocsLink page="windows-agent" label={t('danger.hostRemoval.manualSteps')} /></div>
        </div>
      </Modal>
    </LeftBehindContext.Provider>
  );
}
