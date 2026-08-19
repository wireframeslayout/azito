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
import { createPortal } from 'react-dom';
import {
  computeTooltipClamp,
  initialTooltipVisibilityState,
  isTooltipOpen,
  tooltipVisibilityReducer,
} from './tooltipLogic';

export interface TooltipProps {
  /** Tooltip body. Kept short — this is a hint, not a panel. */
  content: ReactNode;
  /** Single focusable/hoverable element that triggers the tooltip. */
  children: ReactElement;
}

/** ビューポート基準の絶対配置（`position: fixed` の `left`/`top` にそのまま渡す）。 */
interface TooltipPosition {
  left: number;
  top: number;
  flipToTop: boolean;
  /** 上下どちらにも収まりきらない場合のみ設定。`maxHeight` + `overflowY: 'auto'` を適用する。 */
  maxHeight: number | null;
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
 *
 * Positioning: portaled to `document.body` and rendered `position: fixed` in
 * viewport coordinates — ancestors that clip overflow (e.g. `Workspace.tsx`'s
 * tab panes, `SplitLayout.tsx`'s split panes both use `overflow: hidden`)
 * cannot cut it off, unlike an in-tree `position: absolute` tooltip. Geometry
 * is computed from `wrapperEl.getBoundingClientRect()` (viewport-relative,
 * same basis as `position: fixed`) via `computeTooltipClamp()`, then
 * converted to an absolute `left`/`top` — no `translate(-50%)` centering,
 * since re-measuring an already-transformed box would make corrections
 * diverge across reopens/resizes (see `tooltipLogic.ts`). The tooltip
 * re-measures on `resize` and `scroll` (capture) while open, since `fixed`
 * positioning does not track an ancestor's scroll offset the way `absolute`
 * did. Viewport bounds prefer `window.visualViewport` (falling back to
 * `window.innerWidth/innerHeight`) since `innerWidth/innerHeight` describe the
 * *layout* viewport — during pinch-zoom or with an on-screen virtual keyboard
 * open, the actually-visible area can be smaller, which would otherwise place
 * the tooltip off-screen. When neither placement fully fits (e.g. a short
 * split pane), `computeTooltipClamp()` picks the side with more room and
 * returns a `maxHeight` the tooltip must respect with internal scrolling.
 */
export function Tooltip({ content, children }: TooltipProps) {
  const [visibility, dispatch] = useReducer(tooltipVisibilityReducer, initialTooltipVisibilityState);
  const open = isTooltipOpen(visibility);
  const tooltipId = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const wrapperEl = wrapperRef.current;
      const tooltipEl = tooltipRef.current;
      if (!wrapperEl || !tooltipEl) return;
      // 正準幾何（未補正・下側配置基準）を必ずここから作ること — `wrapperEl` 自身には
      // transform を当てていないので `getBoundingClientRect()` は安全だが、`tooltipEl` の
      // 矩形は前回の shiftX/flipToTop 補正後の transform を反映してしまうため使わない。
      // 代わりに transform の影響を受けない `offsetWidth`/`offsetHeight` を使う
      // （このテスト範囲は tooltipLogic.test.ts 側の契約テストではカバーできない —
      // 呼び出し側のこの2点が守られているかは目視レビューで担保する）。
      const wrapperRect = wrapperEl.getBoundingClientRect();
      // `window.innerWidth/innerHeight` describe the layout viewport, which stays full-size
      // during pinch-zoom or with an on-screen keyboard open — the actually-visible area
      // (`visualViewport`) can be smaller/offset, so prefer it when available (Safari/older
      // WebViews without `visualViewport` fall back to the layout viewport).
      const vv = window.visualViewport;
      const clamp = computeTooltipClamp({
        wrapperLeft: wrapperRect.left,
        wrapperRight: wrapperRect.right,
        wrapperTop: wrapperRect.top,
        wrapperBottom: wrapperRect.bottom,
        tooltipWidth: tooltipEl.offsetWidth,
        tooltipHeight: tooltipEl.offsetHeight,
        viewportWidth: vv?.width ?? window.innerWidth,
        viewportHeight: vv?.height ?? window.innerHeight,
        viewportOffsetLeft: vv?.offsetLeft ?? 0,
        viewportOffsetTop: vv?.offsetTop ?? 0,
      });
      const wrapperCenterX = (wrapperRect.left + wrapperRect.right) / 2;
      setPosition({
        left: wrapperCenterX - tooltipEl.offsetWidth / 2 + clamp.shiftX,
        top: clamp.top,
        flipToTop: clamp.flipToTop,
        maxHeight: clamp.maxHeight,
      });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', measure);
    vv?.addEventListener('scroll', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      vv?.removeEventListener('resize', measure);
      vv?.removeEventListener('scroll', measure);
    };
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

  // レビュー指摘 #2: 利用側が既に `aria-describedby` を付けている場合、上書きせず連結する。
  const existingDescribedBy = childProps['aria-describedby'];
  const describedBy = [
    typeof existingDescribedBy === 'string' ? existingDescribedBy.trim() : undefined,
    tooltipId,
  ]
    .filter(Boolean)
    .join(' ');

  const trigger = cloneElement(children, {
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onFocus: handleFocus,
    onBlur: handleBlur,
    onKeyDown: handleKeyDown,
    'aria-describedby': describedBy,
  } as Record<string, unknown>);

  const closedOffsetY = position?.flipToTop ? -4 : 4;
  // 初回測定前（position === null）は画面外に置き、opacity/visibility でも二重に隠す。
  const left = position?.left ?? -9999;
  const top = position?.top ?? -9999;
  // 上下どちらにも収まりきらない場合のみ maxHeight が設定される。その場合はスクロールで内容
  // を読めるようにする必要があるため、`pointerEvents: 'none'`（ホバー中の操作を邪魔しない
  // ための既定）を一時的に 'auto' に切り替える。
  const maxHeight = position?.maxHeight ?? null;

  const tooltipEl = (
    <span
      ref={tooltipRef}
      role="tooltip"
      id={tooltipId}
      className="ui-tooltip"
      style={{
        position: 'fixed',
        left,
        top,
        transform: `translateY(${open ? 0 : closedOffsetY}px)`,
        // GlassPopover(130)/BottomSheet(130) などの既存オーバーレイより上、
        // ContextMenu(310) より上（メニュー項目にツールチップが付く場合も隠れない）、
        // NotificationCenter(400)/UpdateOverlay(1000) より下（通知・更新中の最前面は譲る）。
        zIndex: 320,
        maxWidth: 'min(320px, calc(100vw - 16px))',
        ...(maxHeight != null ? { maxHeight, overflowY: 'auto' as const } : {}),
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
        // 通常はホバー/操作を妨げないよう none。maxHeight で内容が切られている場合のみ、
        // 中身をスクロールで読めるよう auto にする（#28 レビュー指摘 #2: 収まらない場合の救済）。
        pointerEvents: maxHeight != null ? 'auto' : 'none',
        transition: 'opacity 0.14s ease, transform 0.14s ease, visibility 0.14s ease',
      }}
    >
      {content}
    </span>
  );

  return (
    <span ref={wrapperRef} style={{ display: 'inline-flex' }}>
      {trigger}
      {createPortal(tooltipEl, document.body)}
    </span>
  );
}
