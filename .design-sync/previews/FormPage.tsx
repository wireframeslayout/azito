import { FormPage, FormField, FormInput, FormSelect } from '@azito/frontend';

const fields = (
  <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
    <FormField label="Project name" required>
      <FormInput value="azito-agent-base" onChange={() => {}} />
    </FormField>
    <FormField label="Default server" hint="Where tmux windows for this project are created.">
      <FormSelect value="server01" onChange={() => {}}>
        <option value="server01">server01 (local)</option>
        <option value="wakanda">wakanda (agent)</option>
      </FormSelect>
    </FormField>
    <FormField label="Working directory">
      <FormInput value="/home/user/workspace/azito" onChange={() => {}} />
    </FormField>
  </div>
);

export const EditProject = () => (
  <div style={{ maxWidth: 640, height: 380, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
    <FormPage
      title="Edit Project — azito-agent-base"
      submitLabel="Save"
      onSubmit={() => {}}
      onCancel={() => {}}
      backLabel="Projects"
      onBack={() => {}}
    >
      {fields}
    </FormPage>
  </div>
);

export const SubmittingWithError = () => (
  <div style={{ maxWidth: 640, height: 380, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
    <FormPage
      title="New Unit"
      submitLabel="Create"
      loading
      loadingLabel="Creating…"
      onSubmit={() => {}}
      onCancel={() => {}}
      error="Server 'wakanda' is offline — cannot verify working directory."
    >
      {fields}
    </FormPage>
  </div>
);
