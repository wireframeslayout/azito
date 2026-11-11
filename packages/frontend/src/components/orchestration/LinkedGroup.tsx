import type { ReactNode } from 'react';
import { Button } from '../ui/Button';
import { ProjectAvatar } from '../ui/ProjectAvatar';
interface Props { title: string; count: number; children: ReactNode; project?: { name: string; icon?: string | null; color?: string | null }; projectLabel?: string; onProject?: () => void }
export function LinkedGroup({ title, count, children, project, projectLabel, onProject }: Props) {
  return <section style={{ minWidth: 0, marginBottom: 'var(--space-4)' }}><h3 style={{ margin: '0 0 var(--space-2)', flexWrap: 'wrap', display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--text)', fontSize: 'var(--font-sm)' }}>{project && <ProjectAvatar project={project} size={20} />}{title} ({count}) {onProject && <Button size="sm" onClick={onProject}>{projectLabel}</Button>}</h3><ul style={{ listStyle: 'none', padding: 0, margin: 0, minWidth: 0, display: 'grid', gap: 'var(--space-2)' }}>{children}</ul></section>;
}
