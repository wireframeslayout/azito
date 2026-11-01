import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RightPanel } from './RightPanel';
import { RightPanelToggle } from './RightPanelToggle';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function Example({ onChange }: { onChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(true);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const change = (value: boolean) => { onChange(value); setOpen(value); };
  return <>
    {!open && <RightPanelToggle open={false} onToggle={() => change(true)} controls="test-panel" buttonRef={toggleRef} />}
    <RightPanel id="test-panel" title="Connected windows" open={open} onOpenChange={change} toggleRef={toggleRef}>
      <button>Panel action</button>
    </RightPanel>
  </>;
}

describe('RightPanel', () => {
  it('names the aside and restores focus to the opening control when closed', async () => {
    const onChange = vi.fn();
    render(<Example onChange={onChange} />);
    const aside = screen.getByRole('complementary', { name: 'Connected windows' });
    const close = within(aside).getByRole('button', { name: 'rightPanel.close' });
    expect(close).toHaveAttribute('aria-expanded', 'true');
    expect(close).toHaveAttribute('aria-controls', 'test-panel');
    close.focus();
    fireEvent.click(close);
    expect(onChange).toHaveBeenCalledWith(false);
    const open = screen.getByRole('button', { name: 'rightPanel.open' });
    expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(open).toHaveAttribute('aria-controls', 'test-panel');
    await waitFor(() => expect(open).toHaveFocus());
    const content = document.getElementById('test-panel')!;
    expect(content).toHaveAttribute('hidden');
    expect(content).toHaveAttribute('inert');
    expect(screen.queryByRole('button', { name: 'Panel action' })).not.toBeInTheDocument();
    fireEvent.click(open);
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole('complementary', { name: 'Connected windows' })).toBeVisible();
  });
});
