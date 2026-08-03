import React from 'react';

export function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 'var(--font-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-dim)', marginBottom: 8 }}>
      {children}
    </div>
  );
}
