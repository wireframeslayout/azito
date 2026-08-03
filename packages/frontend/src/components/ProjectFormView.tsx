import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { FormPage } from './ui';
import ProjectGeneralFields from './ProjectGeneralFields';
import { notifyProjectsChanged } from '../lib/projectsChanged';

interface ProjectFormViewProps {
  onSaved: (projectId?: number) => void;
  onCancel: () => void;
  backLabel?: string;
  onBack?: () => void;
}

export default function ProjectFormView({ onSaved, onCancel, backLabel, onBack }: ProjectFormViewProps) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [color, setColor] = useState('');
  const [projectRepoUrl, setProjectRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [sidekickPrompt, setSidekickPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation(['projects', 'common']);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) { setError(t('form.nameRequired')); return; }
    if (!slug.trim()) { setError(t('form.slugRequired')); return; }
    setError(null);
    setSaving(true);
    try {
      const created = await api<{ id: number }>('/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          slug: slug.trim(),
          description: description.trim(),
          repository_url: projectRepoUrl.trim() || null,
          default_branch: defaultBranch.trim() || 'main',
          sidekick_prompt: sidekickPrompt.trim(),
          icon: icon.trim() || null,
          color: color.trim() || null,
        }),
      });
      notifyProjectsChanged();
      onSaved(created.id);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [name, slug, description, projectRepoUrl, defaultBranch, sidekickPrompt, icon, color, onSaved]);

  return (
    <FormPage
      title={t('form.newProject')}
      submitLabel={t('form.createProject')}
      onSubmit={handleCreate}
      onCancel={onCancel}
      loading={saving}
      loadingLabel={t('common:actions.creating')}
      error={error}
      backLabel={backLabel}
      onBack={onBack}
    >
      <ProjectGeneralFields
        name={name} setName={setName}
        slug={slug} setSlug={setSlug}
        slugManuallyEdited={slugManuallyEdited} setSlugManuallyEdited={setSlugManuallyEdited}
        description={description} setDescription={setDescription}
        icon={icon} setIcon={setIcon}
        color={color} setColor={setColor}
        projectRepoUrl={projectRepoUrl} setProjectRepoUrl={setProjectRepoUrl}
        defaultBranch={defaultBranch} setDefaultBranch={setDefaultBranch}
        sidekickPrompt={sidekickPrompt} setSidekickPrompt={setSidekickPrompt}
      />
    </FormPage>
  );
}
