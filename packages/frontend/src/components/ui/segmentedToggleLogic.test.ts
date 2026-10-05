import { describe, expect, it } from 'vitest';
import { nextEnabledOption } from './segmentedToggleLogic';

const opts = [{ value: 'a' }, { value: 'b' }, { value: 'c' }];

describe('nextEnabledOption', () => {
  it('moves to the next and previous option', () => {
    expect(nextEnabledOption(opts, 'a', 1)?.value).toBe('b');
    expect(nextEnabledOption(opts, 'c', -1)?.value).toBe('b');
  });

  it('wraps around at both ends', () => {
    expect(nextEnabledOption(opts, 'c', 1)?.value).toBe('a');
    expect(nextEnabledOption(opts, 'a', -1)?.value).toBe('c');
  });

  it('skips disabled options', () => {
    const withDisabled = [{ value: 'a' }, { value: 'b', disabled: true }, { value: 'c' }];
    expect(nextEnabledOption(withDisabled, 'a', 1)?.value).toBe('c');
    expect(nextEnabledOption(withDisabled, 'c', -1)?.value).toBe('a');
  });

  it('does nothing when the whole toggle is disabled, or there is nowhere to go', () => {
    expect(nextEnabledOption(opts, 'a', 1, true)).toBeNull();
    expect(nextEnabledOption([{ value: 'a' }, { value: 'b', disabled: true }], 'a', 1)).toBeNull();
    expect(nextEnabledOption([{ value: 'a', disabled: true }, { value: 'b' }, { value: 'c' }], 'a', 1)).toBeNull();
  });
});
