import type { ReactNode } from 'react';
interface Props { title: string; count: number; children: ReactNode; projectLabel?: string; onProject?: () => void }
export function LinkedGroup({ title, count, children, projectLabel, onProject }: Props) {
  return <section><h3 style={{ color: 'var(--text)', fontSize: 'var(--font-sm)' }}>{title} ({count}) {onProject && <button type="button" onClick={onProject}>{projectLabel}</button>}</h3><ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 'var(--space-2)' }}>{children}</ul></section>;
}
