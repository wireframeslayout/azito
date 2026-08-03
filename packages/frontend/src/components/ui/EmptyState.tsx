import React from 'react';

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-dim)' }}>
      <h3 style={{ fontSize: 'var(--font-lg)', marginBottom: 8, color: 'var(--text)' }}>{title}</h3>
      {description && <p style={{ fontSize: 'var(--font-md)', marginBottom: 16 }}>{description}</p>}
      {action}
    </div>
  );
}
