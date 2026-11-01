import { stepMatches, type KeySpec } from './keySpec';

export interface ChordMatcher { feed(e: KeyboardEvent, now: number): 'none' | 'pending' | 'matched' }
export function createChordMatcher(spec: KeySpec, defaultWindowMs: number): ChordMatcher {
  let index = 0;
  let last = 0;
  return { feed(e, now) {
    if (e.repeat || e.isComposing || e.key === 'Process') return 'none';
    if (index && now - last > (spec.windowMs ?? defaultWindowMs)) index = 0;
    if (!stepMatches(spec.steps[index], e)) {
      index = 0;
      if (!stepMatches(spec.steps[0], e)) return 'none';
    }
    index++;
    last = now;
    if (index === spec.steps.length) { index = 0; return 'matched'; }
    return 'pending';
  } };
}
