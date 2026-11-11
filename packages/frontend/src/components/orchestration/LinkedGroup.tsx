import type { ReactNode } from 'react';
import { IconButton } from '../ui/IconButton';
import { Icon } from '../ui/Icon';
import { ProjectAvatar } from '../ui/ProjectAvatar';
interface Props { title: string; count: number; children: ReactNode; project?: { name: string; icon?: string | null; color?: string | null }; projectLabel?: string; onProject?: () => void }
export function LinkedGroup({ title, count, children, project, projectLabel, onProject }: Props) {
  return <section style={{ minWidth: 0, marginBottom: 'var(--space-4)' }}><h3 style={{ margin: '0 0 var(--space-2)', flexWrap: 'wrap', display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}>{project && <ProjectAvatar project={project} size={20} />}{title} ({count}) {onProject && <IconButton aria-label={`${title} ${projectLabel}`} title={`${title} ${projectLabel}`} onClick={onProject}><Icon name="external-link" size={14} /></IconButton>}</h3><ul style={{ listStyle: 'none', padding: 0, margin: 0, minWidth: 0, display: 'grid', gap: 'var(--space-2)' }}>{children}</ul></section>;
}
