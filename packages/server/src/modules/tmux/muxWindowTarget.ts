import { tmuxTargetFromMuxRef, type MuxRef } from '@azito/shared';

/**
 * The `<workspace>:<window>` string a window row stores in `tmux_target`.
 * tmux refs carry a real tmux target; a misao ref has none (its window is an id such as `w_01...`),
 * so the same shape is built from its parts — the window's stable identity stays in `mux_ref`.
 */
export function muxWindowTarget(ref: MuxRef): string {
  return ref.kind === 'misao' ? `${ref.workspace}:${ref.window}` : tmuxTargetFromMuxRef(ref);
}
