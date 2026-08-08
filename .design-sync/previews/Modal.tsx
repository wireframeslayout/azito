import { Modal, Button, FormField, FormInput } from '@azito/frontend';

export const ConfirmDialog = () => (
  <div style={{ position: 'relative', width: '100%', height: 320, overflow: 'hidden' }}>
    <Modal
      title="Delete task #495?"
      open
      onClose={() => {}}
      actions={<Button variant="danger">Delete</Button>}
    >
      <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: 0 }}>
        The tmux window, worktree, and temp files for this task will be removed.
        This cannot be undone.
      </p>
    </Modal>
  </div>
);

export const WithForm = () => (
  <div style={{ position: 'relative', width: '100%', height: 380, overflow: 'hidden' }}>
    <Modal
      title="Rename window"
      open
      onClose={() => {}}
      actions={<Button variant="primary">Save</Button>}
    >
      <FormField label="Window name" hint="Shown in the sidebar and tab bar">
        <FormInput defaultValue="claude — implementing" />
      </FormField>
    </Modal>
  </div>
);
