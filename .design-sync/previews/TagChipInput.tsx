import { TagChipInput } from '@azito/frontend';

const PHASE_TAGS = ['planning', 'implementing', 'reviewing', 'testing', 'pushing'];

export const WithPhaseSuggestions = () => (
  <TagChipInput
    value={['implementing', 'reviewing']}
    onChange={() => {}}
    suggestions={PHASE_TAGS}
    aria-label="Sidekick tags"
  />
);

export const EmptyWithPlaceholder = () => (
  <TagChipInput
    value={[]}
    onChange={() => {}}
    suggestions={PHASE_TAGS}
    placeholder="Add a tag and press Enter"
    aria-label="Sidekick tags"
  />
);

export const FreeFormTags = () => (
  <TagChipInput
    value={['pushing', 'git', 'no-pr', 'batch-ops']}
    onChange={() => {}}
    aria-label="Sidekick tags"
  />
);

export const Disabled = () => (
  <TagChipInput
    value={['planning', 'builtin']}
    onChange={() => {}}
    disabled
    aria-label="Sidekick tags"
  />
);
