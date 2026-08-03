import { BottomSheet, ListRow, PixelIcon, Chip } from '@azito/frontend';

// position: fixed resolves against the transformed wrapper (containing block),
// keeping the sheet + backdrop inside the card cell.
export const WindowActions = () => (
  <div
    style={{
      position: 'relative',
      transform: 'translate(0, 0)',
      height: 320,
      maxWidth: 400,
      border: '1px dashed var(--border)',
      borderRadius: 8,
      overflow: 'hidden',
    }}
  >
    <BottomSheet open onClose={() => {}} title="tmux window — 2: claude">
      <ListRow
        size="sm"
        icon={<PixelIcon name="terminal" size={14} mono />}
        title="Open terminal"
        onClick={() => {}}
      />
      <ListRow
        size="sm"
        icon={<PixelIcon name="pin" size={14} mono />}
        title="Mark as supervised"
        chips={<Chip tone="accent">agent</Chip>}
        onClick={() => {}}
      />
      <ListRow
        size="sm"
        icon={<PixelIcon name="trash" size={14} mono />}
        title="Kill window"
        onClick={() => {}}
      />
    </BottomSheet>
  </div>
);
