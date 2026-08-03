import { Button } from '@azito/frontend';

export const Variants = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
    <Button>Cancel</Button>
    <Button variant="primary">Save task</Button>
    <Button variant="danger">Delete</Button>
    <Button variant="ghost">View logs</Button>
  </div>
);

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
    <Button variant="primary" size="md">Create project</Button>
    <Button variant="primary" size="sm">Add window</Button>
    <Button size="sm">Refresh</Button>
  </div>
);

export const States = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
    <Button variant="primary" loading loadingLabel="Deploying...">Deploy</Button>
    <Button disabled>Disabled</Button>
    <Button variant="danger" disabled>Delete</Button>
  </div>
);
