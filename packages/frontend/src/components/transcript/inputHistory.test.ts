import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadHistory, pushHistory } from './inputHistory';

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
  } as Storage;
}

describe('inputHistory', () => {
  const originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;

  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = createMemoryStorage();
  });

  afterEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage;
  });

  it('returns an empty array when nothing has been saved', () => {
    expect(loadHistory()).toEqual([]);
  });

  it('adds entries to the front, newest first', () => {
    pushHistory('first');
    pushHistory('second');
    expect(loadHistory()).toEqual(['second', 'first']);
  });

  it('promotes an exact-duplicate entry to the front instead of storing it twice', () => {
    pushHistory('first');
    pushHistory('second');
    pushHistory('first');
    expect(loadHistory()).toEqual(['first', 'second']);
  });

  it('ignores an empty string', () => {
    pushHistory('');
    expect(loadHistory()).toEqual([]);
  });

  it('caps the history at 50 entries, dropping the oldest', () => {
    for (let i = 0; i < 55; i++) pushHistory(`entry-${i}`);
    const history = loadHistory();
    expect(history).toHaveLength(50);
    expect(history[0]).toBe('entry-54');
    expect(history[49]).toBe('entry-5');
  });

  it('ignores malformed stored JSON and returns an empty array', () => {
    localStorage.setItem('azito.transcript.inputHistory', 'not json');
    expect(loadHistory()).toEqual([]);
  });

  it('filters out non-string entries from malformed stored data', () => {
    localStorage.setItem('azito.transcript.inputHistory', JSON.stringify(['ok', 42, null, 'also ok']));
    expect(loadHistory()).toEqual(['ok', 'also ok']);
  });

  it('does not throw when localStorage is unavailable', () => {
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
    expect(() => pushHistory('x')).not.toThrow();
    expect(loadHistory()).toEqual([]);
  });
});
