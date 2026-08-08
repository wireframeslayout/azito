import { ActiveWindowDot } from '@azito/frontend';

// ActiveWindowDot is absolutely positioned top-right; real usage is inside the
// 34px collapsed Active Windows icon button in the workspace sidebar rail.
export const OnCollapsedWindowIcon = () => (
  <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
    {['#482', '#495'].map((task) => (
      <span key={task} style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
        <span
          style={{
            position: 'relative',
            width: 34,
            height: 34,
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px solid var(--border)',
            background: 'var(--bg-elevated)',
          }}
        >
          <span style={{ fontFamily: 'var(--mono, ui-monospace, monospace)', fontSize: 15, color: 'var(--text-dim)' }}>✳</span>
          <ActiveWindowDot />
        </span>
        <span style={{ fontFamily: 'var(--mono, ui-monospace, monospace)', fontSize: 8.5, color: 'var(--text-dim)' }}>{task}</span>
      </span>
    ))}
    <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 8 }}>idle agent windows (green check badge)</span>
  </div>
);
