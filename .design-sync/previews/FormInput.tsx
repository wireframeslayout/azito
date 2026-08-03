import { FormInput, FormTextarea, FormSelect } from '@azito/frontend';

export const Input = () => (
  <div style={{ maxWidth: 380, display: 'grid', gap: 10 }}>
    <FormInput placeholder="Search projects…" />
    <FormInput defaultValue="azito-agent-base" />
    <FormInput disabled defaultValue="read-only value" />
  </div>
);

export const Textarea = () => (
  <div style={{ maxWidth: 380 }}>
    <FormTextarea rows={3} placeholder="Task description…" />
  </div>
);

export const Select = () => (
  <div style={{ maxWidth: 380 }}>
    <FormSelect defaultValue="ssh">
      <option value="local">local</option>
      <option value="ssh">ssh</option>
      <option value="agent">agent</option>
    </FormSelect>
  </div>
);
