import { ResourceMeter } from '@azito/frontend';

const row = { display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)', color: 'var(--text-dim)' } as const;

export const Levels = () => (
  <div style={{ display: 'grid', gap: 10, maxWidth: 300 }}>
    <div style={row}><span style={{ minWidth: 34, color: 'var(--text)' }}>CPU</span><ResourceMeter value={12} /><span>12%</span></div>
    <div style={row}><span style={{ minWidth: 34, color: 'var(--text)' }}>MEM</span><ResourceMeter value={64} /><span>64%</span></div>
    <div style={row}><span style={{ minWidth: 34, color: 'var(--text)' }}>DISK</span><ResourceMeter value={91} warning /><span>91%</span></div>
  </div>
);

export const FullWidth = () => (
  <div style={{ maxWidth: 300, display: 'grid', gap: 6 }}>
    <div style={{ fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>
      swap 1.9 GB / 2.0 GB
    </div>
    <ResourceMeter value={97} warning width="100%" />
  </div>
);
