import { useTranslation } from 'react-i18next';
import type { MuxPaneProcessState } from '@azito/shared';
import { Chip } from './Chip';
import { paneStateChip } from '../../lib/paneState';

/** A pane whose process is gone is shown dimmed; its state chip stays at full strength. */
export const DIMMED_PANE_OPACITY = 0.6;

interface PaneStateChipProps {
  pane: { processState?: MuxPaneProcessState };
}

/** "Stopped" / "Exited" marker for a pane whose process is gone. Renders nothing for a live pane. */
export function PaneStateChip({ pane }: PaneStateChipProps) {
  const { t } = useTranslation('common');
  const state = paneStateChip(pane);
  if (!state) return null;
  return <Chip tone={state === 'stopped' ? 'orange' : 'default'}>{t(`paneState.${state}`)}</Chip>;
}
