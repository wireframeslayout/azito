import { useId } from 'react';
import { Button } from './Button';
import { Tooltip } from './Tooltip';

type ButtonProps = React.ComponentProps<typeof Button>;

interface BlockedActionButtonProps extends Omit<ButtonProps, 'disabled'> {
  /** Why the action is closed; null / absent: the button is an ordinary one. */
  blockedReason?: string | null;
  /**
   * `inline`: the reason is shown as text next to the button. Otherwise it is a tooltip (hover and focus), for dense rows
   * where a line of text per button would not fit.
   */
  reasonDisplay?: 'inline' | 'tooltip';
  /** The id of a reason that is already on screen (e.g. a form's own notice): the button points at it instead of rendering one. */
  reasonId?: string;
  /** The button is disabled for a reason of its own (loading, invalid input), independent of the block. */
  disabled?: boolean;
}

/**
 * A button whose action is closed with a stated reason. It stays focusable (`aria-disabled`, not `disabled`, which takes
 * the button out of the tab order and so hides the reason from the keyboard), does nothing when activated, and is tied
 * to the reason with `aria-describedby`.
 */
export function BlockedActionButton({ blockedReason, reasonDisplay = 'tooltip', reasonId, onClick, style, disabled, ...rest }: BlockedActionButtonProps) {
  const ownReasonId = useId();
  if (!blockedReason) return <Button {...rest} disabled={disabled} onClick={onClick} style={style} />;

  const describedBy = reasonId ?? (reasonDisplay === 'inline' ? ownReasonId : undefined);
  const button = (
    <Button
      {...rest}
      aria-disabled="true"
      aria-describedby={describedBy}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
      style={{ ...style, opacity: 0.5, cursor: 'not-allowed' }}
    />
  );
  if (reasonId) return button;
  if (reasonDisplay === 'inline') {
    return (
      <>
        {button}
        <span id={ownReasonId} style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>{blockedReason}</span>
      </>
    );
  }
  return <Tooltip content={blockedReason}>{button}</Tooltip>;
}
