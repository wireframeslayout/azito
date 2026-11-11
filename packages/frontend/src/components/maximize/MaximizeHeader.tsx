import { useTranslation } from 'react-i18next';
import { resolveWindowTitle } from '@azito/shared';
import type { ProjectListItem, Task, Window } from '../../pages/workspace/types';
import { windowTitleInput } from '../../lib/windowDisplay';
import { Button, Chip, WindowIdChip } from '../ui';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { TerminalChatToggle } from '../ui/TerminalChatToggle';
import type { WindowViewMode } from '../../lib/windowViewMode';
import WindowActivityIndicator from '../ui/WindowActivityIndicator';

interface MaximizeHeaderProps {
  window?: Window;
  task?: Task;
  project?: ProjectListItem;
  status: 'working' | 'blocked' | 'idle' | 'unknown';
  finishedAt?: number;
  viewMode: WindowViewMode;
  onViewModeChange: (mode: WindowViewMode) => void;
  onFocus: () => void;
  onOpenTask: () => void;
  onOpenTab: () => void;
  onClose: () => void;
}
export function MaximizeHeader({ window, task, project, status, finishedAt, viewMode, onViewModeChange, onFocus, onOpenTask, onOpenTab, onClose }: MaximizeHeaderProps) {
  const { t } = useTranslation('workspace');
  return <header onFocusCapture={onFocus} style={{ flexWrap: 'wrap', display: 'flex', gap: 'var(--space-2)', alignItems: 'center', padding: 'var(--space-3)', borderBottom: '1px solid var(--border)', minWidth: 0 }}>
    <Chip tone="accent">{t('maximize.expanded')}</Chip>
    <h2 id="maximize-title" style={{ margin: 0, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--font-sm)', flex: 1 }}>{task && <>{task.title} › </>}{window ? resolveWindowTitle({ ...windowTitleInput(window), tmuxTarget: window.tmuxTarget }).title : t('maximize.missing')}</h2>
    {window && <><WindowIdChip id={window.id} /><Chip>{window.serverName}</Chip>{project && <Chip>{project.name}</Chip>}{window.sleeping ? <span>{t('maximize.sleeping')}</span> : <><WindowActivityIndicator status={status === 'working' || status === 'blocked' ? status : status === 'idle' && finishedAt != null ? 'finished' : null} finishedAt={finishedAt} /><span style={{ fontSize: 'var(--font-xs)' }}>{t(`maximize.status.${status}`)}</span></>}</>}
    {window && !window.sleeping && <TerminalChatToggle value={viewMode} onChange={onViewModeChange} />}
    {task && <Button size="sm" onClick={onOpenTask}><Icon name="tasks" size={14} /> {t('maximize.openTask')}</Button>}
    {window && <Button size="sm" onClick={onOpenTab}><Icon name="terminal" size={14} /> {t('maximize.openTab')}</Button>}
    <IconButton onClick={onClose} aria-label={t('maximize.close')} title={t('maximize.close')} style={{ minWidth: 'calc(var(--space-5) + var(--space-6))', minHeight: 'calc(var(--space-5) + var(--space-6))' }}><Icon name="close" size={16} /></IconButton>
  </header>;
}
