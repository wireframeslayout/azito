import { StatusDropdown } from '@azito/frontend';

/**
 * The dropdown menu opens on click (internal state) so cells show the badge
 * trigger states; manual statuses (open/done) render the caret, running-family
 * and archived statuses render as disabled badges.
 */
export const ManualStatuses = () => (
  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
    <StatusDropdown status="open" onChange={() => {}} />
    <StatusDropdown status="done" onChange={() => {}} />
  </div>
);

export const RunningLocked = () => (
  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
    <StatusDropdown status="running" onChange={() => {}} />
    <StatusDropdown status="in_progress" onChange={() => {}} />
    <StatusDropdown status="waiting_input" onChange={() => {}} />
    <StatusDropdown status="phase_review" onChange={() => {}} />
  </div>
);

export const TerminalStatuses = () => (
  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
    <StatusDropdown status="review" onChange={() => {}} />
    <StatusDropdown status="failed" onChange={() => {}} />
    <StatusDropdown status="archived" onChange={() => {}} />
  </div>
);

export const ExplicitlyDisabled = () => (
  <StatusDropdown status="open" onChange={() => {}} disabled />
);
