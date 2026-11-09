import type { ReactNode } from 'react';
import { ProjectAvatar } from '../ui/ProjectAvatar';
interface Props { title: string; count: number; children: ReactNode; project?: { name: string; icon?: string | null; color?: string | null }; projectLabel?: string; onProject?: () => void }
export function LinkedGroup({ title, count, children, project, projectLabel, onProject }: Props) {
  return <section><h3 style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--text)', fontSize: 'var(--font-sm)' }}>{project && <ProjectAvatar project={project} size={20} />}{title} ({count}) {onProject && <button type="button" onClick={onProject}>{projectLabel}</button>}</h3><ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 'var(--space-2)' }}>{children}</ul></section>;
}
