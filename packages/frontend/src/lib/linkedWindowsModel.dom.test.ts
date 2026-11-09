// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { acknowledgeLinkedCompletion, isLinkedCompletionAcknowledged } from './linkedWindowsModel';
it('acknowledges only the recorded completion occurrence', () => {
  localStorage.clear();
  acknowledgeLinkedCompletion(1, '2026-01-01T00:00:00Z');
  expect(isLinkedCompletionAcknowledged(1, '2026-01-01T00:00:00Z')).toBe(true);
  expect(isLinkedCompletionAcknowledged(1, '2026-01-02T00:00:00Z')).toBe(false);
  expect(isLinkedCompletionAcknowledged(2, '2026-01-01T00:00:00Z')).toBe(false);
});
