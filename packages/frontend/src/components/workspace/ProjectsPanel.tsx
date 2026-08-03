import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import { paths } from '../../paths';
import { LoadingState, EmptyState, PageContainer, PageHeader, PageBody, Chip } from '../ui';
import { ListRow, ListRowGroup } from '../ui/ListRow';

interface Project {
  id: number;
  name: string;
  description?: string;
  workingDirectory?: string;
  icon?: string | null;
  color?: string | null;
  windows: { id: number }[];
  repositories: { id: number }[];
  createdAt: string;
}

interface ProjectsPanelProps {
  onCreateProject?: () => void;
}

export default function ProjectsPanel({ onCreateProject }: ProjectsPanelProps) {
  const { t } = useTranslation('projects');
  const navigate = useNavigate();
  const { data: projects, loading } = useApi<Project[]>('/projects');

  if (loading) return <LoadingState />;

  return (
    <PageContainer style={{ padding: 0 }}>
      <PageHeader
        title={t('title')}
        count={projects?.length}
        primaryAction={{
          label: t('newProject'),
          shortLabel: t('newProjectShort'),
          onClick: () => (onCreateProject ? onCreateProject() : navigate(paths.projectNew())),
        }}
      />
      <PageBody>
      {!projects?.length ? (
        <EmptyState title={t('emptyState.title')} description={t('emptyState.description')} />
      ) : (
        <ListRowGroup>
          {projects.map((p) => {
            const iconContent = p.icon && p.icon.startsWith('data:') ? (
              <img src={p.icon} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : p.icon ? (
              <span style={{ fontSize: 'var(--font-lg)' }}>{p.icon}</span>
            ) : (
              <span style={{ fontSize: 'var(--font-md)', fontWeight: 600, color: p.color || 'var(--text-dim)' }}>
                {p.name.charAt(0).toUpperCase()}
              </span>
            );
            return (
              <ListRow
                key={p.id}
                icon={iconContent}
                accentColor={p.color || undefined}
                title={p.name}
                description={p.description}
                chips={
                  <>
                    <Chip>{t('chips.windows', { count: (p.windows || []).length })}</Chip>
                    <Chip>{t('chips.repos', { count: (p.repositories || []).length })}</Chip>
                    {p.workingDirectory && <Chip>{p.workingDirectory}</Chip>}
                  </>
                }
                onClick={() => navigate(paths.workspace(p.id))}
              />
            );
          })}
        </ListRowGroup>
      )}
      </PageBody>
    </PageContainer>
  );
}
