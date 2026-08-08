import { EmptyState, Button } from '@azito/frontend';

export const Basic = () => (
  <EmptyState
    title="No tasks yet"
    description="Create a task to start an agent run on this project."
  />
);

export const WithAction = () => (
  <EmptyState
    title="No servers connected"
    description="Add a local, SSH, or agent server to manage its tmux sessions."
    action={<Button variant="primary">Add server</Button>}
  />
);
