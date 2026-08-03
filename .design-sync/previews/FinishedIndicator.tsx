import { FinishedIndicator } from '@azito/frontend';

export const AgentFinished = () => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text)' }}>
    <FinishedIndicator />
    <span style={{ fontSize: 10, color: 'var(--green)' }}>完了 · 3分前</span>
    <span style={{ marginLeft: 6, fontFamily: 'var(--mono, ui-monospace, monospace)' }}>azito:2 task-478-pushing</span>
  </span>
);
