import { GlassPopover, PixelIcon } from '@azito/frontend';

// position: fixed resolves against the transformed wrapper (containing block),
// so the popover stays inside the card cell. bottom offset is 76px + safe-area,
// hence the tall wrappers.
const wrapStyle = {
  position: 'relative' as const,
  transform: 'translate(0, 0)',
  height: 300,
  maxWidth: 360,
  border: '1px dashed var(--border)',
  borderRadius: 8,
  overflow: 'hidden',
};

export const ProjectSwitcher = () => (
  <div style={wrapStyle}>
    <GlassPopover
      open
      onClose={() => {}}
      label="Projects"
      ariaLabel="Switch project"
      items={[
        { key: 'azito', label: 'azito-agent-base', icon: <PixelIcon name="projects" size={14} />, selected: true, onSelect: () => {} },
        { key: 'herdr', label: 'herdr', icon: <PixelIcon name="projects" size={14} />, onSelect: () => {} },
        { key: 'wfs', label: 'wfs-harness', icon: <PixelIcon name="projects" size={14} />, onSelect: () => {} },
      ]}
    />
  </div>
);

export const RightAlignedActions = () => (
  <div style={wrapStyle}>
    <GlassPopover
      open
      onClose={() => {}}
      align="right"
      ariaLabel="More actions"
      items={[
        { key: 'files', label: 'Files', icon: <PixelIcon name="files" size={14} mono />, onSelect: () => {} },
        { key: 'usage', label: 'Token usage', icon: <PixelIcon name="chip" size={14} mono />, onSelect: () => {} },
        { key: 'settings', label: 'Settings', icon: <PixelIcon name="settings" size={14} mono />, onSelect: () => {} },
      ]}
    />
  </div>
);
