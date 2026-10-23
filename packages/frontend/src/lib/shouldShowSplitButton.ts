import type { MuxDriverKind } from '@azito/shared';

interface SplitButtonContext {
  /** The mux the shown window lives in; undefined while it is not known. */
  windowKind: MuxDriverKind | undefined;
  isMobile: boolean;
}

/** misao splits panes on its own layout (no tmux-style split), so the split buttons are tmux-only (and hidden on mobile). */
export function shouldShowSplitButton({ windowKind, isMobile }: SplitButtonContext): boolean {
  return !isMobile && windowKind === 'tmux';
}
