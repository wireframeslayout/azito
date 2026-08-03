import { PixelIcon } from '@azito/frontend';

const NAV = ['tasks', 'files', 'servers', 'settings', 'bell', 'terminal', 'windows', 'git', 'storage', 'projects', 'sidekicks', 'units', 'operations', 'browser'] as const;
const ACTIONS = ['play', 'stop', 'edit', 'trash', 'refresh', 'plus', 'close', 'check', 'warning', 'extlink', 'watch', 'menu'] as const;

const cell: React.CSSProperties = { display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-dim)', width: 58 };

export const NavigationSet = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, maxWidth: 420 }}>
    {NAV.map((n) => (
      <span key={n} style={cell}>
        <PixelIcon name={n} size={24} />
        {n}
      </span>
    ))}
  </div>
);

export const ActionSet16 = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, maxWidth: 420 }}>
    {ACTIONS.map((n) => (
      <span key={n} style={cell}>
        <PixelIcon name={n} size={16} />
        {n}
      </span>
    ))}
  </div>
);

export const MonoVsPalette = () => (
  <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text)' }}>
      <PixelIcon name="servers" size={24} /> palette
    </span>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--accent)' }}>
      <PixelIcon name="servers" size={24} mono /> mono (currentColor)
    </span>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-dim)' }}>
      <PixelIcon name="servers" size={24} mono /> mono dim
    </span>
  </div>
);

export const Scaling = () => (
  <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end' }}>
    {[16, 24, 48].map((s) => (
      <span key={s} style={cell}>
        <PixelIcon name="tasks" size={s} />
        {s}px
      </span>
    ))}
  </div>
);
