import { expect, it, vi } from 'vitest';
import { shouldHandleTerminalKey } from './terminalDispatch';
it('only consumes a matched keydown', () => {
  const dispatch = vi.fn().mockReturnValue(false);
  expect(shouldHandleTerminalKey({ type: 'keyup' } as KeyboardEvent, dispatch)).toBe(false);
  expect(dispatch).not.toHaveBeenCalled();
  expect(shouldHandleTerminalKey({ type: 'keydown' } as KeyboardEvent, dispatch)).toBe(false);
  dispatch.mockReturnValue(true);
  expect(shouldHandleTerminalKey({ type: 'keydown' } as KeyboardEvent, dispatch)).toBe(true);
});
