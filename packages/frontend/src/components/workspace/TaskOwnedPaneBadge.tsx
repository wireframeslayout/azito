import { useTranslation } from 'react-i18next';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { useHealth } from '../../hooks/useHealth';
import { resolveTaskOwnedPaneBadgeCopy } from './taskOwnedPaneBadgeCopy';

/**
 * Always-on indicator for a task-owned terminal pane (Issue #28 design v3 §9
 * / Phase D-2): shown unconditionally whenever the underlying window is
 * task-owned — the pane's actual purpose ("this is where the task
 * executes") doesn't depend on whether scoped authorization enforcement is
 * currently on or off. The LABEL, however, must reflect enforcement
 * honestly (Issue #28 third-party review Important finding): while
 * AZITO_SCOPED_AUTH is off (compat mode), a UI token is deliberately
 * injected into every task pane's env and input sent into it DOES carry
 * operator-equivalent privileges — the previous unconditional "restricted
 * privileges" wording gave a false sense of safety during the migration
 * window. `scopedAuthEnabled === null` (health not yet loaded) falls back
 * to the compat-mode wording too, since "unknown" must never read as
 * "restricted" when it might not be.
 */
export function TaskOwnedPaneBadge() {
  const { t } = useTranslation('common');
  const { scopedAuthEnabled } = useHealth();
  const { labelKey, tooltipKey } = resolveTaskOwnedPaneBadgeCopy(scopedAuthEnabled);
  const label = t(labelKey);
  const tooltip = t(tooltipKey);
  return (
    <span
      tabIndex={0}
      title={tooltip}
      aria-label={tooltip}
      style={{ display: 'inline-flex', alignItems: 'center', marginRight: 4 }}
    >
      <Badge tone="orange" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <Icon name="lock" size={14} />
        {label}
      </Badge>
    </span>
  );
}
