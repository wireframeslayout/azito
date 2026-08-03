import { AzitoLogoShort } from '@azito/frontend';

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 20, alignItems: 'flex-end' }}>
    {[20, 28, 48, 72].map((s) => (
      <span key={s} style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-dim)' }}>
        <AzitoLogoShort size={s} />
        {s}px
      </span>
    ))}
  </div>
);

export const AsHeaderMark = () => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '8px 14px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10 }}>
    <AzitoLogoShort size={28} />
    <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--text)' }}>AZITO</span>
  </span>
);
