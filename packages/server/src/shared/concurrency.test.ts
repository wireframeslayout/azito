import { expect, it } from 'vitest';
import { runWithConcurrency } from './concurrency';

it('runs every task with the requested limit', async () => {
  let active = 0, peak = 0, completed = 0;
  const tasks = Array.from({ length: 12 }, () => async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--; completed++;
  });
  await runWithConcurrency(tasks, 4);
  expect(peak).toBe(4);
  expect(completed).toBe(12);
});
