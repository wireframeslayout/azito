import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { HotkeyProvider, useHotkeyBindings } from '../../hooks/useHotkeys';
import { parseKeySpec } from '../../lib/hotkeys/keySpec';
import { Overlay } from './Overlay';

function isInertTree(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) if (node.inert) return true;
  return false;
}
function emulateBrowserFocus(): void {
  const focus = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
    if (!isInertTree(this)) focus.call(this, options);
  });
  vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(callback => callback());
}
function renderInRoot(ui: ReactElement) {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  return render(ui, { container: root });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.getElementById('root')?.remove();
});

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
    fireEvent.keyDown(screen.getByText('Last'), { key: 'Tab' });
    expect(screen.getByText('First')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    rerender(<HotkeyProvider><Overlay open={false} labelledBy="example" onClose={onClose}><h2 id="example">Example</h2><button>First</button></Overlay></HotkeyProvider>);
    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });

  it('keeps a child autoFocus and still returns focus to the trigger', async () => {
    const view = (open: boolean) => <HotkeyProvider>
      <button>Trigger</button>
      <Overlay open={open} labelledBy="auto" onClose={() => {}}><h2 id="auto">Auto</h2><button>Option</button><input aria-label="Name" autoFocus /></Overlay>
    </HotkeyProvider>;
    const { rerender } = render(view(false));
    screen.getByText('Trigger').focus();
    rerender(view(true));
    expect(screen.getByLabelText('Name')).toHaveFocus();
    rerender(view(false));
    await waitFor(() => expect(screen.getByText('Trigger')).toHaveFocus());
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

  it('returns focus to the trigger only after the root is no longer inert', async () => {
    emulateBrowserFocus();
    const view = (open: boolean) => <HotkeyProvider>
      <button>Trigger</button>
      <Overlay open={open} labelledBy="restore" onClose={() => {}}><h2 id="restore">Restore</h2><button>Inside</button></Overlay>
    </HotkeyProvider>;
    const { rerender } = renderInRoot(view(false));
    screen.getByText('Trigger').focus();
    rerender(view(true));
    expect(screen.getByText('Inside')).toHaveFocus();
    expect(document.getElementById('root')!.inert).toBe(true);
    rerender(view(false));
    await waitFor(() => expect(screen.getByText('Trigger')).toHaveFocus());
    expect(document.getElementById('root')!.inert).toBeFalsy();
  });

  it('returns focus to the underlying dialog only after it is no longer inert', async () => {
    emulateBrowserFocus();
    const view = (nested: boolean) => <HotkeyProvider>
      <Overlay open labelledBy="outer" onClose={() => {}}>
        <h2 id="outer">Outer</h2><button>Open nested</button>
      </Overlay>
      <Overlay open={nested} labelledBy="inner" onClose={() => {}}>
        <h2 id="inner">Inner</h2><button>Inner action</button>
      </Overlay>
    </HotkeyProvider>;
    const { rerender } = renderInRoot(view(false));
    screen.getByText('Open nested').focus();
    rerender(view(true));
    expect(screen.getByText('Inner action')).toHaveFocus();
    expect(screen.getByRole('dialog', { name: 'Outer', hidden: true }).inert).toBe(true);
    rerender(view(false));
    await waitFor(() => expect(screen.getByText('Open nested')).toHaveFocus());
  });
});

it('passes Escape through when the overlay predicate rejects it', async () => {
  const close = vi.fn();
  render(<HotkeyProvider><Overlay open labelledBy="escape-test" onClose={close} shouldCloseOnEscape={event => !(event.target instanceof HTMLInputElement)}><h2 id="escape-test">Escape test</h2><input aria-label="terminal" /><button>Other</button></Overlay></HotkeyProvider>);
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  screen.getByLabelText('terminal').dispatchEvent(event);
  await new Promise(resolve => setTimeout(resolve));
  expect(event.defaultPrevented).toBe(false);
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByText('Other'), { key: 'Escape' });
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});

it('allows the maximize toggle chord in an editable target', async () => {
  const close = vi.fn();
  function Configure() {
    const { setBinding } = useHotkeyBindings();
    return <><button onClick={() => setBinding('search.open', null)}>Disable search</button><button onClick={() => setBinding('maximize.open', parseKeySpec('Space Space'))}>Assign chord</button></>;
  }
  render(<HotkeyProvider><Configure /><Overlay open labelledBy="toggle" onClose={close} toggleAction="maximize.open" toggleWhen="always"><h2 id="toggle">Toggle</h2><input aria-label="terminal" /></Overlay></HotkeyProvider>);
  fireEvent.click(screen.getByText('Disable search'));
  fireEvent.click(screen.getByText('Assign chord'));
  fireEvent.keyDown(screen.getByLabelText('terminal'), { key: ' ' });
  fireEvent.keyDown(screen.getByLabelText('terminal'), { key: ' ' });
  expect(close).toHaveBeenCalledOnce();
  localStorage.clear();
});
