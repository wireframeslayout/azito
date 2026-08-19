import { useTranslation } from 'react-i18next';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { Tooltip } from '../ui/Tooltip';
import { useHealth } from '../../hooks/useHealth';
import { useIsMobile } from '../../hooks/useIsMobile';
import { resolveTaskOwnedPaneBadgeCopy } from './taskOwnedPaneBadgeCopy';

/**
 * Always-on indicator for a task-owned terminal pane (Issue #28 design v3 §9
 * / Phase D-2, revised to C案 in the follow-up pass): shown unconditionally
 * whenever the underlying window is task-owned — the pane's actual purpose
 * ("this is where the task executes") doesn't depend on whether scoped
 * authorization enforcement is currently on or off. The LABEL, tone, and
 * icon, however, must reflect enforcement honestly (Issue #28 third-party
 * review Important finding): while AZITO_SCOPED_AUTH is off (compat mode), a
 * UI token is deliberately injected into every task pane's env and input
 * sent into it DOES carry operator-equivalent privileges. C案 additionally
 * inverts which state gets the "attention" tone: scoped-enabled is the
 * normal/expected state (neutral, quiet), compat mode is the one that
 * actually warrants notice (orange + warning icon) — previously both states
 * shared the same warning-orange styling, burying the case operators need to
 * see. `scopedAuthEnabled === null` (health not yet loaded) falls back to
 * the compat-mode wording/tone too, since "unknown" must never read as
 * "restricted" when it might not be.
 *
 * The long explanation moves from a native `title` attribute (no wrapping/
 * timing control) into the reusable `Tooltip` component. At narrow widths
 * (`useIsMobile`) the text label is dropped entirely — icon only — but the
 * full explanation stays reachable via the tooltip and `aria-label` keeps
 * carrying the full text regardless of viewport, so no information is lost
 * for assistive tech.
 */
export function TaskOwnedPaneBadge() {
  const { t } = useTranslation('common');
  const { scopedAuthEnabled } = useHealth();
  const isMobile = useIsMobile();
  const { labelKey, tooltipKey, tone, icon } = resolveTaskOwnedPaneBadgeCopy(scopedAuthEnabled);
  const label = t(labelKey);
  const tooltip = t(tooltipKey);
  return (
    <Tooltip content={tooltip}>
      <span
        tabIndex={0}
        aria-label={tooltip}
        style={{ display: 'inline-flex', alignItems: 'center', marginRight: 4 }}
      >
        <Badge tone={tone} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon name={icon} size={14} />
          {!isMobile && label}
        </Badge>
      </span>
    </Tooltip>
  );
}
