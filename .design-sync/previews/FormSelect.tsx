import { FormSelect, FormField } from '@azito/frontend';

export const Basic = () => (
  <div style={{ maxWidth: 380 }}>
    <FormField label="Worker">
      <FormSelect defaultValue="claude">
        <option value="claude">Claude Code</option>
        <option value="codex">Codex (gpt-5-codex)</option>
        <option value="generic">Generic</option>
      </FormSelect>
    </FormField>
  </div>
);
