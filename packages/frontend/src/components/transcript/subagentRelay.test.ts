import { describe, expect, it } from 'vitest';
import { resolveSubagentRelay } from './subagentRelay';

const child = { id: 'a', routingName: 'worker' as string | null | undefined, status: 'unknown' as const };

describe('resolveSubagentRelay', () => {
  it('allows a uniquely named child whose status is unknown', () => {
    expect(resolveSubagentRelay([child], 'a')).toEqual({ kind: 'available', name: 'worker', status: 'unknown' });
  });
  it('reports an outdated agent only when the list lacks routing names', () => {
    expect(resolveSubagentRelay([{ ...child, routingName: undefined }], 'a')).toEqual({ kind: 'unavailable', reason: 'agent_outdated' });
  });
  it('does not blame the agent while the list is unavailable', () => {
    expect(resolveSubagentRelay(null, 'a')).toEqual({ kind: 'unavailable', reason: 'unavailable' });
  });
  it.each([
    ['finished', [{ ...child, status: 'finished' as const }]],
    ['unnamed', [{ ...child, routingName: null }]],
    ['duplicate', [child, { ...child, id: 'b' }]],
  ])('refuses a %s child', (_label, agents) => {
    expect(resolveSubagentRelay(agents, 'a')).toEqual({ kind: 'unavailable', reason: 'unavailable' });
  });
});
