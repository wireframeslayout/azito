import { FormField, FormInput, FormSelect, FormTextarea } from '@azito/frontend';

export const Basic = () => (
  <div style={{ maxWidth: 420 }}>
    <FormField label="Task title" required>
      <FormInput defaultValue="Add unzoom button to window header" />
    </FormField>
    <FormField label="Worker" hint="Agent that runs this task">
      <FormSelect defaultValue="claude">
        <option value="claude">Claude Code</option>
        <option value="codex">Codex (gpt-5-codex)</option>
      </FormSelect>
    </FormField>
  </div>
);

export const ErrorState = () => (
  <div style={{ maxWidth: 420 }}>
    <FormField label="Branch name" error="Branch already exists on origin">
      <FormInput defaultValue="feature/unzoom-button" />
    </FormField>
    <FormField label="Description">
      <FormTextarea rows={3} defaultValue="Restore a zoomed pane from the UI." />
    </FormField>
  </div>
);
