import { BlockedDot } from '@azito/frontend';

export const ApprovalWaiting = () => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text)' }}>
    <BlockedDot />
    <span style={{ fontSize: 10, color: 'var(--orange)' }}>承認待ち</span>
    <span style={{ marginLeft: 6, fontFamily: 'var(--mono, ui-monospace, monospace)' }}>azito:1 task-482-implementing</span>
  </span>
);

export const InBlockedRow = () => (
  <div
    className="aw-row-blocked"
    style={{ display: 'flex', alignItems: 'center', gap: 8, width: 260, padding: '7px 10px', borderRadius: 6, fontSize: 12, color: 'var(--text)' }}
  >
    <BlockedDot />
    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>codex-review — permission prompt</span>
    <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>#495</span>
  </div>
);
