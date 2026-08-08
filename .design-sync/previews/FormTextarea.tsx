import { FormTextarea, FormField } from '@azito/frontend';

export const Basic = () => (
  <div style={{ maxWidth: 420 }}>
    <FormField label="Task description" hint="Passed to the agent as the task prompt">
      <FormTextarea
        rows={4}
        defaultValue={'Add an unzoom button to the window header.\nRestore a zoomed pane from the UI.'}
      />
    </FormField>
  </div>
);
