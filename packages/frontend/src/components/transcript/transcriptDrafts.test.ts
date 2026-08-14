import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearDraft, loadDraft, saveDraft } from './transcriptDrafts';

/** vitest の実行環境は `environment: 'node'` のため localStorage が存在しない。
 * Map バックの簡易実装を globalThis に差し込み、テスト後に元へ戻す。 */
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

describe('transcriptDrafts', () => {
  const originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;

  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = createMemoryStorage();
  });

  afterEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage;
  });

  it('returns an empty string when nothing has been saved', () => {
    expect(loadDraft('session-1')).toBe('');
  });

  it('round-trips saved text', () => {
    saveDraft('session-1', 'hello world');
    expect(loadDraft('session-1')).toBe('hello world');
  });

  it('saving an empty string removes the entry instead of storing it', () => {
    saveDraft('session-1', 'hello world');
    saveDraft('session-1', '');
    expect(loadDraft('session-1')).toBe('');
    expect(localStorage.getItem('azito.transcript.draft.session-1')).toBeNull();
  });

  it('clearDraft removes a previously saved draft', () => {
    saveDraft('session-1', 'hello world');
    clearDraft('session-1');
    expect(loadDraft('session-1')).toBe('');
  });

  it('keys drafts independently per sessionId', () => {
    saveDraft('session-1', 'draft A');
    saveDraft('session-2', 'draft B');
    expect(loadDraft('session-1')).toBe('draft A');
    expect(loadDraft('session-2')).toBe('draft B');
  });

  it('does not throw when localStorage is unavailable', () => {
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
    expect(() => saveDraft('session-1', 'x')).not.toThrow();
    expect(loadDraft('session-1')).toBe('');
    expect(() => clearDraft('session-1')).not.toThrow();
  });
});
