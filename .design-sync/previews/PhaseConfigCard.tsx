import { PhaseConfigCard } from '@azito/frontend';

const reviewOptions = [
  { name: 'reviewing-default', isDefault: true },
  { name: 'strict-security-review', isDefault: false },
  { name: 'forge', isDefault: false },
];

export const EnabledDefault = () => (
  <PhaseConfigCard
    phaseLabel="Reviewing"
    options={reviewOptions}
    value={undefined}
    onChange={() => {}}
  />
);

export const CustomSidekickSelected = () => (
  <PhaseConfigCard
    phaseLabel="Implementing"
    options={[
      { name: 'implementing-default', isDefault: true },
      { name: 'tdd-implementing', isDefault: false },
    ]}
    value={{ sidekick: 'tdd-implementing' }}
    onChange={() => {}}
  />
);

export const PhaseDisabled = () => (
  <PhaseConfigCard
    phaseLabel="Testing"
    options={[{ name: 'testing-default', isDefault: true }]}
    value={{ enabled: false }}
    onChange={() => {}}
  />
);

export const NoDefaultConfigured = () => (
  <PhaseConfigCard
    phaseLabel="Pushing"
    options={[{ name: 'push-no-pr', isDefault: false }]}
    value={undefined}
    onChange={() => {}}
  />
);
