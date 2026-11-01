import React from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '../ui/IconButton';
import { Icon } from '../ui/Icon';

export interface RightPanelToggleProps { open: boolean; onToggle: () => void; controls: string; buttonRef?: React.Ref<HTMLButtonElement> }
export function RightPanelToggle({ open, onToggle, controls, buttonRef }: RightPanelToggleProps) {
  const { t } = useTranslation('workspace');
  const label = t(open ? 'rightPanel.close' : 'rightPanel.open');
  return <IconButton ref={buttonRef} title={label} aria-label={label} aria-expanded={open} aria-controls={controls} onClick={onToggle}><Icon name={open ? 'panel-right-close' : 'panel-right-open'} size={16} /></IconButton>;
}
