import { Slider } from '@azito/frontend';

export const WithLabelAndValue = () => (
  <Slider
    label="Terminal font size"
    value={14}
    min={10}
    max={24}
    onChange={() => {}}
    formatValue={(v) => `${v}px`}
  />
);

export const PercentFormat = () => (
  <Slider
    label="Background dim"
    value={65}
    min={0}
    max={100}
    step={5}
    onChange={() => {}}
    formatValue={(v) => `${v}%`}
  />
);

export const NearMinimum = () => (
  <Slider
    label="Max concurrent resumes"
    value={1}
    min={1}
    max={10}
    onChange={() => {}}
  />
);

export const Unlabeled = () => (
  <Slider value={80} min={0} max={100} onChange={() => {}} />
);
