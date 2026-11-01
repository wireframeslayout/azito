import { expect, it } from 'vitest';
import { isEditableTarget } from './editable';
it('recognizes editing areas and terminals', () => {
  for (const html of ['<input>', '<textarea></textarea>', '<div contenteditable="true"><span></span></div>', '<div class="xterm"><span></span></div>']) {
    const container = document.createElement('div'); container.innerHTML = html;
    expect(isEditableTarget(container.querySelector('span') ?? container.firstElementChild)).toBe(true);
  }
  expect(isEditableTarget(document.createElement('button'))).toBe(false);
});
