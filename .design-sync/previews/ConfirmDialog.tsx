import { ConfirmDialog } from '@azito/frontend';

/**
 * ConfirmDialog renders a position:fixed overlay. Each cell wraps it in a
 * transformed container so `fixed` resolves against the wrapper, keeping the
 * dialog inside the card.
 */
const frame = {
  position: 'relative',
  transform: 'translateZ(0)',
  width: '100%',
  height: 260,
  overflow: 'hidden',
  borderRadius: 8,
};

export const DangerConfirm = () => (
  <div style={frame}>
    <ConfirmDialog
      open
      title="Delete task #495?"
      message="The tmux window, worktree, and temp files for this task will be removed. This cannot be undone."
      onConfirm={() => {}}
      onCancel={() => {}}
      confirmLabel="Delete task"
    />
  </div>
);

export const PrimaryConfirm = () => (
  <div style={frame}>
    <ConfirmDialog
      open
      title="Reinstall agent on wakanda?"
      message="The agent bundle will be redeployed over SSH and the remote process restarted. Running tmux sessions are preserved."
      onConfirm={() => {}}
      onCancel={() => {}}
      confirmLabel="Reinstall"
      confirmVariant="primary"
    />
  </div>
);

export const LoadingState = () => (
  <div style={frame}>
    <ConfirmDialog
      open
      title="Remove worktree?"
      message="Removing ../azito-worktrees/task-512 and pruning stale worktree metadata."
      onConfirm={() => {}}
      onCancel={() => {}}
      loading
      confirmLabel="Remove"
    />
  </div>
);
