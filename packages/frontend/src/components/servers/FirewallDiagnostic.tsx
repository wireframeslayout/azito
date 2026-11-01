import type { ServerStatus } from '../../hooks/useServerManagement';

interface FirewallDiagnosticProps {
  diagnostic: NonNullable<ServerStatus['firewall']>;
}

export function FirewallDiagnostic({ diagnostic }: FirewallDiagnosticProps) {
  return (
    <div role="status" style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
      <div>{diagnostic.detail}</div>
      <div>Network profile: {diagnostic.networkCategory ?? 'unknown'} · Checked: {new Date(diagnostic.checkedAt).toLocaleString()}</div>
    </div>
  );
}
