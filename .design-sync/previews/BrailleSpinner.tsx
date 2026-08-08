import { BrailleSpinner } from '@azito/frontend';

export const WorkingAgent = () => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text)' }}>
    <BrailleSpinner />
    <span style={{ fontFamily: 'var(--mono, ui-monospace, monospace)' }}>claude — implementing #482</span>
  </span>
);

export const InWorkingRow = () => (
  <div
    className="aw-row-working"
    style={{ display: 'flex', alignItems: 'center', gap: 8, width: 260, padding: '7px 10px', borderRadius: 6, fontSize: 12, color: 'var(--text)', background: 'var(--bg-elevated)' }}
  >
    <BrailleSpinner />
    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>task-482-implementing</span>
    <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>#482</span>
  </div>
);
