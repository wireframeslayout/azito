import { CodexIcon } from '@azito/frontend';

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 20, alignItems: 'flex-end' }}>
    {[12, 16, 24, 32].map((s) => (
      <span key={s} style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-dim)' }}>
        <span style={{ color: 'var(--text)' }}><CodexIcon size={s} /></span>
        {s}px
      </span>
    ))}
  </div>
);

export const AsWorkerLabel = () => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text)', padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8 }}>
    <CodexIcon size={16} />
    gpt-5-codex · second-opinion review
  </span>
);
