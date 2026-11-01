import React, { useRef } from 'react';
import { PanelHeader } from '../ui/PanelHeader';
import { RightPanelToggle } from './RightPanelToggle';

export interface RightPanelProps {
  id: string;
  title: string;
  actions?: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The caller's open button; focus returns to it when the panel is closed from inside. */
  toggleRef?: React.RefObject<HTMLButtonElement | null>;
  children: React.ReactNode;
}

export function RightPanel({ id, title, actions, open, onOpenChange, toggleRef, children }: RightPanelProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const close = (): void => {
    const restoreFocus = contentRef.current?.contains(document.activeElement);
    onOpenChange(false);
    if (restoreFocus) requestAnimationFrame(() => toggleRef?.current?.focus());
  };
  return (
    <aside aria-label={title} aria-hidden={open ? undefined : true} className={`workspace-right-panel${open ? ' is-open' : ''}`}>
      <div ref={contentRef} id={id} hidden={!open} inert={open ? undefined : true} className="workspace-right-panel-content">
        <PanelHeader title={title} actions={<>{actions}<RightPanelToggle open={open} onToggle={close} controls={id} /></>} />
        <div className="workspace-right-panel-body">{children}</div>
      </div>
    </aside>
  );
}
