import {
  cloneElement,
  isValidElement,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  computeTooltipClamp,
  initialTooltipVisibilityState,
  isTooltipOpen,
  tooltipVisibilityReducer,
  type TooltipClampResult,
} from './tooltipLogic';

export interface TooltipProps {
  /** Tooltip body. Kept short — this is a hint, not a panel. */
  content: ReactNode;
  /** Single focusable/hoverable element that triggers the tooltip. */
  children: ReactElement;
}

const NO_CLAMP: TooltipClampResult = { shiftX: 0, flipToTop: false };

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
 *
 * Positioning: the tooltip defaults to trigger-centered below the trigger,
 * then clamps horizontally (and flips above when there's no room below) so it
 * never runs off-screen — right-aligned toolbar triggers (e.g.
 * `TaskOwnedPaneBadge`) and narrow mobile viewports both stay readable. No
 * ancestor here uses `overflow: hidden`, so clamping within this stacking
 * context is enough; a portal isn't needed (see `tooltipLogic.ts`).
 */
export function Tooltip({ content, children }: TooltipProps) {
  const [visibility, dispatch] = useReducer(tooltipVisibilityReducer, initialTooltipVisibilityState);
  const open = isTooltipOpen(visibility);
  const tooltipId = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [clamp, setClamp] = useState<TooltipClampResult>(NO_CLAMP);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const wrapperEl = wrapperRef.current;
      const tooltipEl = tooltipRef.current;
      if (!wrapperEl || !tooltipEl) return;
      const triggerRect = wrapperEl.getBoundingClientRect();
      const tooltipRect = tooltipEl.getBoundingClientRect();
      setClamp(
        computeTooltipClamp({
          tooltipLeft: tooltipRect.left,
          tooltipRight: tooltipRect.right,
          tooltipBottom: tooltipRect.bottom,
          tooltipHeight: tooltipRect.height,
          triggerTop: triggerRect.top,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        }),
      );
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-measure whenever content changes size too
  }, [open, content]);

  if (!isValidElement(children)) return children;

  const childProps = children.props as Record<string, unknown>;

  const handleMouseEnter = (e: MouseEvent) => {
    (childProps.onMouseEnter as ((e: MouseEvent) => void) | undefined)?.(e);
    dispatch({ type: 'mouseenter' });
  };
  const handleMouseLeave = (e: MouseEvent) => {
    (childProps.onMouseLeave as ((e: MouseEvent) => void) | undefined)?.(e);
    dispatch({ type: 'mouseleave' });
  };
  const handleFocus = (e: FocusEvent) => {
    (childProps.onFocus as ((e: FocusEvent) => void) | undefined)?.(e);
    dispatch({ type: 'focus' });
  };
  const handleBlur = (e: FocusEvent) => {
    (childProps.onBlur as ((e: FocusEvent) => void) | undefined)?.(e);
    dispatch({ type: 'blur' });
  };
  const handleKeyDown = (e: KeyboardEvent) => {
    (childProps.onKeyDown as ((e: KeyboardEvent) => void) | undefined)?.(e);
    if (e.key === 'Escape') dispatch({ type: 'escape' });
  };

  const trigger = cloneElement(children, {
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onFocus: handleFocus,
    onBlur: handleBlur,
    onKeyDown: handleKeyDown,
    'aria-describedby': tooltipId,
  } as Record<string, unknown>);

  const closedOffsetY = clamp.flipToTop ? -4 : 4;

  return (
    <span ref={wrapperRef} style={{ position: 'relative', display: 'inline-flex' }}>
      {trigger}
      <span
        ref={tooltipRef}
        role="tooltip"
        id={tooltipId}
        className="ui-tooltip"
        style={{
          position: 'absolute',
          top: clamp.flipToTop ? 'auto' : 'calc(100% + 8px)',
          bottom: clamp.flipToTop ? 'calc(100% + 8px)' : 'auto',
          left: '50%',
          transform: `translate(calc(-50% + ${clamp.shiftX}px), ${open ? 0 : closedOffsetY}px)`,
          zIndex: 140,
          maxWidth: 'min(320px, calc(100vw - 16px))',
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
