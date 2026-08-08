import { useTranslation } from 'react-i18next';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';

/**
 * Always-on indicator for a task-owned terminal pane (Issue #28 design v3 §9
 * / Phase D-2): input sent into this pane never elevates the sender's
 * privileges — it runs the task's own worker process, which is provisioned
 * with an `AZITO_TASK_TOKEN` (task principal), not the operator's UI token.
 * Shown unconditionally whenever the underlying window is task-owned,
 * independent of whether scoped authorization enforcement is currently on
 * (design v3 §12 compat mode) or off — the pane's actual purpose ("this is
 * where the task executes") doesn't change either way.
 */
export function TaskOwnedPaneBadge() {
  const { t } = useTranslation('common');
  return (
    <span
      tabIndex={0}
      title={t('terminal.taskOwnedPaneTooltip')}
      aria-label={t('terminal.taskOwnedPaneTooltip')}
      style={{ display: 'inline-flex', alignItems: 'center', marginRight: 4 }}
    >
      <Badge tone="orange" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <Icon name="lock" size={14} />
        {t('terminal.taskOwnedPaneBadge')}
      </Badge>
    </span>
  );
}
