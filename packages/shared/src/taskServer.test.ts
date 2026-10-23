import { describe, it, expect } from 'vitest';
import { pickTaskExecutionServer } from './taskServer';

describe('pickTaskExecutionServer', () => {
  it('uses the task\'s own server', () => {
    expect(pickTaskExecutionServer('a', ['b'])).toBe('a');
    expect(pickTaskExecutionServer('a', [])).toBe('a');
  });

  it('uses the project\'s only server when the task names none', () => {
    expect(pickTaskExecutionServer(null, ['win'])).toBe('win');
    expect(pickTaskExecutionServer(undefined, ['win'])).toBe('win');
  });

  it('is null when there is nothing to run on or the choice is ambiguous', () => {
    expect(pickTaskExecutionServer(null, [])).toBeNull();
    expect(pickTaskExecutionServer(null, ['a', 'b'])).toBeNull();
  });
});
