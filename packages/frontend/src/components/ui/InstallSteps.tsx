export interface InstallStep {
  step: string;
  status: 'running' | 'ok' | 'error';
  message: string;
}

export function InstallSteps({ steps }: { steps: InstallStep[] }) {
  return (
    <div style={{ fontSize: 'var(--font-sm)', lineHeight: 1.8, padding: '8px 0' }}>
      {steps.map((s, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, color: s.status === 'error' ? 'var(--danger)' : s.status === 'ok' ? 'var(--success)' : 'var(--text-dim)' }}>
          <span>{s.status === 'ok' ? '✓' : s.status === 'error' ? '✗' : '…'}</span>
          <span style={{ textTransform: 'capitalize' }}>{s.step}</span>
          <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}>{s.message}</span>
        </div>
      ))}
    </div>
  );
}
