import { useTranslation } from 'react-i18next';
import type { ServerStatus } from '../../hooks/useServerManagement';

interface FirewallDiagnosticProps {
  diagnostic: NonNullable<ServerStatus['firewall']>;
}

/** The hub's Windows Firewall diagnosis of an agent that does not answer: what was found, on which network profile, and when. */
export function FirewallDiagnostic({ diagnostic }: FirewallDiagnosticProps) {
  const { t } = useTranslation('servers');
  return (
    <div role="status" style={{ marginTop: 4, color: 'var(--text-dim)', fontSize: 'var(--font-xs)', lineHeight: 1.5, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
      <div>{t(`overview.firewall_${diagnostic.state}`, { rules: diagnostic.blockedBy.join(', ') })}</div>
      {diagnostic.commands.map((command) => <pre key={command} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{command}</pre>)}
      <div>
        {t('overview.firewallMeta', {
          profile: diagnostic.networkCategory ?? t('overview.firewallProfileUnknown'),
          checkedAt: new Date(diagnostic.checkedAt).toLocaleString(),
        })}
      </div>
    </div>
  );
}
