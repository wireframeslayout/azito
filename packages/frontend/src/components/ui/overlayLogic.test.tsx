import { describe, expect, it } from 'vitest';
import { cycleFocus, getFocusableElements } from './overlayLogic';

describe('overlay focus', () => {
  it('wraps focus and skips disabled or inert controls', () => {
    const container = document.createElement('div');
    container.innerHTML = '<button>First</button><button disabled>Disabled</button><div inert><button>Hidden</button></div><button>Last</button>';
    document.body.append(container);
    const elements = getFocusableElements(container);
    expect(elements.map(element => element.textContent)).toEqual(['First', 'Last']);
    elements[0].focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true });
    cycleFocus(event, container);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(elements[1]);
    container.remove();
  });
  it('moves focus from the panel to the first or last control', () => {
    const container = document.createElement('div'); container.tabIndex = -1;
    container.innerHTML = '<button>First</button><button>Last</button>'; document.body.append(container);
    const buttons = container.querySelectorAll('button');
    for (const shiftKey of [false, true]) {
      container.focus(); const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true });
      cycleFocus(event, container); expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(buttons[shiftKey ? 1 : 0]);
    }
    container.remove();
  });
});
