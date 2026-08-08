import { PhaseProgressBar } from '@azito/frontend';

const phases = [
  { name: 'planning', label: 'Plan' },
  { name: 'implementing', label: 'Implement' },
  { name: 'reviewing', label: 'Review' },
  { name: 'testing', label: 'Test' },
  { name: 'pushing', label: 'Push' },
];

export const Running = () => (
  <PhaseProgressBar status="running" currentPhase="implementing" phases={phases} />
);

export const WithSelfReview = () => (
  <PhaseProgressBar
    status="running"
    currentPhase="reviewing"
    phases={phases}
    selfReviewCount={2}
    selfReviewMax={3}
  />
);

export const Completed = () => <PhaseProgressBar status="done" phases={phases} />;

export const Failed = () => (
  <PhaseProgressBar status="failed" currentPhase="testing" phases={phases} />
);
