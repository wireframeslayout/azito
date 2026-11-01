import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HotkeyProvider } from '../../hooks/useHotkeys';
import { Overlay } from './Overlay';

describe('Overlay', () => {
  it('focuses and cycles within the dialog, then restores focus', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const { rerender } = render(<HotkeyProvider><Overlay open labelledBy="example" onClose={onClose}><h2 id="example">Example</h2><button>First</button><button>Last</button></Overlay></HotkeyProvider>);
    expect(screen.getByRole('dialog', { name: 'Example' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('First')).toHaveFocus();
    screen.getByText('Last').focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByText('First')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    rerender(<HotkeyProvider><Overlay open={false} labelledBy="example" onClose={onClose}><h2 id="example">Example</h2><button>First</button></Overlay></HotkeyProvider>);
    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });

  it('does not close a busy alert or on its backdrop', () => {
    const onClose = vi.fn();
    render(<HotkeyProvider><Overlay open labelledBy="confirm" variant="alert" busy dismissOnBackdrop={false} onClose={onClose}><h2 id="confirm">Confirm</h2>Message</Overlay></HotkeyProvider>);
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm' });
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(dialog.parentElement!);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
  it('restores focus to the underlying dialog when the top dialog closes', async () => {
    const onClose = vi.fn();
    const view = (nested: boolean) => <HotkeyProvider>
      <Overlay open labelledBy="outer" onClose={onClose}>
        <h2 id="outer">Outer</h2><button>Open nested</button>
        <Overlay open={nested} labelledBy="inner" onClose={onClose}>
          <h2 id="inner">Inner</h2><button>Inner action</button>
        </Overlay>
      </Overlay>
    </HotkeyProvider>;
    const { rerender } = render(view(false));
    screen.getByText('Open nested').focus();
    rerender(view(true));
    expect(screen.getByText('Inner action')).toHaveFocus();
    rerender(view(false));
    await waitFor(() => expect(screen.getByText('Open nested')).toHaveFocus());
  });

});
