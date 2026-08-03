import { TerminalIcon } from '@azito/frontend';

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 20, alignItems: 'flex-end' }}>
    {[12, 16, 24, 32].map((s) => (
      <span key={s} style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-dim)' }}>
        <span style={{ color: 'var(--text)' }}><TerminalIcon size={s} /></span>
        {s}px
      </span>
    ))}
  </div>
);

export const InSessionList = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 220 }}>
    {['azito: 3 windows', 'wakanda: 1 window', 'sandbox: 2 windows'].map((label, i) => (
      <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: i === 0 ? 'var(--text)' : 'var(--text-dim)', padding: '4px 8px', borderRadius: 6, background: i === 0 ? 'var(--bg-elevated)' : 'transparent' }}>
      <TerminalIcon size={14} />
        <span style={{ fontFamily: 'var(--mono, ui-monospace, monospace)' }}>{label}</span>
      </span>
    ))}
  </div>
);
