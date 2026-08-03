import { SubagentConfigCard } from '@azito/frontend';

export const DisabledDefault = () => (
  <SubagentConfigCard
    title="Review subagent"
    description="Delegate the reviewing phase to a separate agent instead of the worker itself."
    value={null}
    onChange={() => {}}
    workerType="claude"
  />
);

export const EnabledWithSelection = () => (
  <SubagentConfigCard
    title="Implement subagent"
    description="Delegate the implementing phase to a separate agent instead of the worker itself."
    value={{ enabled: true, provider: 'codex', model: 'gpt-5-codex' }}
    onChange={() => {}}
    workerType="claude"
  />
);

export const CreditWarning = () => (
  <SubagentConfigCard
    title="Review subagent"
    description="Delegate the reviewing phase to a separate agent instead of the worker itself."
    value={{ enabled: true, provider: 'claude', model: 'sonnet' }}
    onChange={() => {}}
    workerType="codex"
  />
);
