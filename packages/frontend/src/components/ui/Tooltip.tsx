import { cloneElement, isValidElement, useId, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode } from 'react';

export interface TooltipProps {
  /** Tooltip body. Kept short — this is a hint, not a panel. */
  content: ReactNode;
  /** Single focusable/hoverable element that triggers the tooltip. */
  children: ReactElement;
}

/**
 * Generic hover/focus tooltip (Issue #28 C案 §3). Reusable at the ui/ altitude
 * — any trigger element can wrap itself in this to get a delayed-free,
 * wrapping tooltip without reaching for the native `title` attribute (no
 * layout control, no line wrapping, inconsistent OS-level delay).
 *
 * Distinct from GlassPopover: GlassPopover is a menu (`items[].onSelect`,
 * `role="menu"`), this is a passive description (`role="tooltip"`, no
 * interactive content, no click-outside handling needed since it closes on
 * blur/mouseleave/Esc).
 */
export function Tooltip({ content, children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();

  if (!isValidElement(children)) return children;

  const childProps = children.props as Record<string, unknown>;

  const handleMouseEnter = (e: MouseEvent) => {
    (childProps.onMouseEnter as ((e: MouseEvent) => void) | undefined)?.(e);
    setOpen(true);
  };
  const handleMouseLeave = (e: MouseEvent) => {
    (childProps.onMouseLeave as ((e: MouseEvent) => void) | undefined)?.(e);
    setOpen(false);
  };
  const handleFocus = (e: FocusEvent) => {
    (childProps.onFocus as ((e: FocusEvent) => void) | undefined)?.(e);
    setOpen(true);
  };
  const handleBlur = (e: FocusEvent) => {
    (childProps.onBlur as ((e: FocusEvent) => void) | undefined)?.(e);
    setOpen(false);
  };
  const handleKeyDown = (e: KeyboardEvent) => {
    (childProps.onKeyDown as ((e: KeyboardEvent) => void) | undefined)?.(e);
    if (e.key === 'Escape') setOpen(false);
  };

  const trigger = cloneElement(children, {
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onFocus: handleFocus,
    onBlur: handleBlur,
    onKeyDown: handleKeyDown,
    'aria-describedby': tooltipId,
  } as Record<string, unknown>);

  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      {trigger}
      <span
        role="tooltip"
        id={tooltipId}
        className="ui-tooltip"
        style={{
          position: 'absolute',
          top: 'calc(100% + 8px)',
          left: '50%',
          transform: open ? 'translate(-50%, 0)' : 'translate(-50%, 4px)',
          zIndex: 140,
          maxWidth: 320,
          width: 'max-content',
          padding: '10px 13px',
          background: 'var(--bg-elevated)',
          border: '1px solid transparent',
          borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--shadow-2)',
          color: 'var(--text)',
          fontSize: 'var(--font-sm)',
          lineHeight: 1.5,
          whiteSpace: 'normal',
          opacity: open ? 1 : 0,
          visibility: open ? 'visible' : 'hidden',
          pointerEvents: 'none',
          transition: 'opacity 0.14s ease, transform 0.14s ease, visibility 0.14s ease',
        }}
      >
        {content}
      </span>
    </span>
  );
}
