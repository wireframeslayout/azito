import { AgentIcon } from '@azito/frontend';

const row: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text)' };

export const WorkerTypes = () => (
  <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
    <span style={row}><AgentIcon windowType="agent" workerType="claude" /> claude</span>
    <span style={row}><AgentIcon windowType="agent" workerType="codex" /> codex</span>
    <span style={row}><AgentIcon windowType="agent" workerType="generic" /> generic (fallback)</span>
    <span style={row}><AgentIcon windowType="terminal" /> terminal window</span>
  </div>
);

export const InWindowRow = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 240 }}>
    {[
      { worker: 'claude', label: 'azito:1 task-482-planning' },
      { worker: 'codex', label: 'azito:2 review-second-opinion' },
      { worker: undefined, label: 'azito:0 dev-server' },
    ].map((w) => (
      <span key={w.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text)', padding: '4px 8px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6 }}>
        <span style={{ color: 'var(--text-dim)' }}>
          <AgentIcon windowType={w.worker ? 'agent' : 'terminal'} workerType={w.worker} size={14} />
        </span>
        <span style={{ fontFamily: 'var(--mono, ui-monospace, monospace)' }}>{w.label}</span>
      </span>
    ))}
  </div>
);
