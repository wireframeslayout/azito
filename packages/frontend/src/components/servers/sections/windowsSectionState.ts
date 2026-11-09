type SessionsState = 'loading' | 'error' | 'partial' | 'ready';

export function windowsEmptyView(state: SessionsState, count: number): 'loading' | 'unavailable' | 'empty' | 'content' {
  if (count > 0) return 'content';
  if (state === 'loading') return 'loading';
  if (state === 'error' || state === 'partial') return 'unavailable';
  return 'empty';
}
