import React from 'react';

interface MetadataFieldProps {
  label: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}

export function MetadataField({ label, children, action }: MetadataFieldProps) {
  return (
    <div>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 4,
      }}>
        <div style={{
          fontSize: 'var(--font-2xs)', fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: 0.5, color: 'var(--text-dim)',
        }}>
          {label}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}
