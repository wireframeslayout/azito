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
});
