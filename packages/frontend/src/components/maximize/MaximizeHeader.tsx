import { useTranslation } from 'react-i18next';
import { resolveWindowTitle } from '@azito/shared';
import type { ActivityIndicator } from '../../hooks/useAgentActivity';
import type { ProjectListItem, Task, Window } from '../../pages/workspace/types';
import { windowTitleInput } from '../../lib/windowDisplay';
import { Button, Chip, WindowIdChip } from '../ui';
import { TerminalChatToggle } from '../ui/TerminalChatToggle';
import type { WindowViewMode } from '../../lib/windowViewMode';
import WindowActivityIndicator from '../ui/WindowActivityIndicator';

interface MaximizeHeaderProps {
  window?: Window;
  task?: Task;
  project?: ProjectListItem;
  status: ActivityIndicator;
  viewMode: WindowViewMode;
  onViewModeChange: (mode: WindowViewMode) => void;
  onFocus: () => void;
  onOpenTask: () => void;
  onOpenTab: () => void;
  onClose: () => void;
}
export function MaximizeHeader({ window, task, project, status, viewMode, onViewModeChange, onFocus, onOpenTask, onOpenTab, onClose }: MaximizeHeaderProps) {
  const { t } = useTranslation('workspace');
  return <header onFocusCapture={onFocus} style={{ flexWrap: 'wrap', display: 'flex', gap: 'var(--space-2)', alignItems: 'center', padding: 'var(--space-3)', borderBottom: '1px solid var(--border)', minWidth: 0 }}>
    <Chip tone="accent">{t('maximize.expanded')}</Chip>
    <h2 id="maximize-title" style={{ margin: 0, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--font-sm)', flex: 1 }}>{task && <>{task.title} › </>}{window ? resolveWindowTitle({ ...windowTitleInput(window), tmuxTarget: window.tmuxTarget }).title : t('maximize.missing')}</h2>
    {window && <><WindowIdChip id={window.id} /><Chip>{window.serverName}</Chip>{project && <Chip>{project.name}</Chip>}{window.sleeping ? <span>{t('maximize.sleeping')}</span> : <><WindowActivityIndicator status={status} /><span style={{ fontSize: 'var(--font-xs)' }}>{t(`maximize.status.${status ?? 'unknown'}`)}</span></>}</>}
    {window && !window.sleeping && <TerminalChatToggle value={viewMode} onChange={onViewModeChange} />}
    {task && <Button size="sm" onClick={onOpenTask}>{t('maximize.openTask')}</Button>}
    {window && <Button size="sm" onClick={onOpenTab}>{t('maximize.openTab')}</Button>}
    <Button size="sm" onClick={onClose}>{t('maximize.close')}</Button>
  </header>;
}
