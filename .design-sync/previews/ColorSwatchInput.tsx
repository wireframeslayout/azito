import { ColorSwatchInput } from '@azito/frontend';

export const AccentColor = () => (
  <div style={{ maxWidth: 180 }}>
    <ColorSwatchInput label="Accent" value="#4f8cff" onChange={() => {}} />
  </div>
);

export const PaletteRow = () => (
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
    <ColorSwatchInput label="Background" value="#0d1117" onChange={() => {}} />
    <ColorSwatchInput label="Card" value="#161b22" onChange={() => {}} />
    <ColorSwatchInput label="Green" value="#3fb950" onChange={() => {}} />
    <ColorSwatchInput label="Red" value="#f85149" onChange={() => {}} />
  </div>
);

export const NoLabel = () => (
  <div style={{ maxWidth: 120 }}>
    <ColorSwatchInput value="#d29922" onChange={() => {}} />
  </div>
);
