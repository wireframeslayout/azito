import { useTranslation } from 'react-i18next';
import { formatWindowTitleLine, resolveWindowTitle } from '@azito/shared';
import type { ActivityIndicator } from '../../hooks/useAgentActivity';
import type { ProjectListItem, Task, Window } from '../../pages/workspace/types';
import { windowTitleInput } from '../../lib/windowDisplay';
import { Button, WindowIdChip } from '../ui';
import { ProjectAvatar } from '../ui/ProjectAvatar';
import WindowActivityIndicator from '../ui/WindowActivityIndicator';

interface MaximizeHeaderProps {
  window?: Window;
  task?: Task;
  project?: ProjectListItem;
  status: ActivityIndicator;
  onFocus: () => void;
  onOpenTask: () => void;
  onOpenTab: () => void;
  onClose: () => void;
}
export function MaximizeHeader({ window, task, project, status, onFocus, onOpenTask, onOpenTab, onClose }: MaximizeHeaderProps) {
  const { t } = useTranslation('workspace');
  return <header onFocusCapture={onFocus} style={{ flexWrap: 'wrap', display: 'flex', gap: 'var(--space-2)', alignItems: 'center', padding: 'var(--space-3)', borderBottom: '1px solid var(--border)', minWidth: 0 }}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <h2 id="maximize-title" style={{ margin: 0 }}>{task && <>{task.title} › </>}{window ? formatWindowTitleLine(resolveWindowTitle({ ...windowTitleInput(window), tmuxTarget: window.tmuxTarget })) : t('maximize.missing')}</h2>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--text-dim)', fontSize: 'var(--font-sm)' }}>
        {window && <><WindowIdChip id={window.id} /><span>{window.serverName}</span>{project && <><ProjectAvatar project={project} size={20} /><span>{project.name}</span></>}{window.sleeping ? <span>{t('maximize.sleeping')}</span> : <><WindowActivityIndicator status={status} /><span>{t(`maximize.status.${status ?? 'unknown'}`)}</span></>}</>}
      </div>
    </div>
    {task && <Button size="sm" onClick={onOpenTask}>{t('maximize.openTask')}</Button>}
    {window && <Button size="sm" onClick={onOpenTab}>{t('maximize.openTab')}</Button>}
    <Button size="sm" onClick={onClose}>{t('maximize.close')}</Button>
  </header>;
}
