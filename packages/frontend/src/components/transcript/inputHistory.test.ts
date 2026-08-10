import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveContextHistory, loadHistory, pushHistory } from './inputHistory';
import type { TranscriptEntry } from './transcriptTypes';

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

describe('deriveContextHistory', () => {
  function userEntry(uuid: string, text: string): TranscriptEntry {
    return { uuid, type: 'user', timestamp: null, blocks: [{ kind: 'text', text }] };
  }

  it('returns user text entries in newest-first order', () => {
    const entries: TranscriptEntry[] = [userEntry('1', 'first'), userEntry('2', 'second'), userEntry('3', 'third')];
    expect(deriveContextHistory(entries)).toEqual(['third', 'second', 'first']);
  });

  it('excludes non-user entries', () => {
    const entries: TranscriptEntry[] = [
      userEntry('1', 'hello'),
      { uuid: '2', type: 'assistant', timestamp: null, blocks: [{ kind: 'text', text: 'reply' }] },
      { uuid: '3', type: 'system', timestamp: null, blocks: [{ kind: 'text', text: 'sys' }] },
      { uuid: '4', type: 'tool', timestamp: null, blocks: [{ kind: 'tool_use', name: 'x', input: '{}', truncated: false }] },
    ];
    expect(deriveContextHistory(entries)).toEqual(['hello']);
  });

  it('joins multiple text blocks within one user entry', () => {
    const entries: TranscriptEntry[] = [
      { uuid: '1', type: 'user', timestamp: null, blocks: [{ kind: 'text', text: 'line1' }, { kind: 'text', text: 'line2' }] },
    ];
    expect(deriveContextHistory(entries)).toEqual(['line1\nline2']);
  });

  it('excludes empty text entries', () => {
    const entries: TranscriptEntry[] = [userEntry('1', ''), userEntry('2', '   '), userEntry('3', 'real')];
    expect(deriveContextHistory(entries)).toEqual(['real']);
  });

  it('excludes synthetic messages starting with an angle bracket', () => {
    const entries: TranscriptEntry[] = [
      userEntry('1', 'real message'),
      userEntry('2', '<task-notification>done</task-notification>'),
      userEntry('3', '<system-reminder>ignore me</system-reminder>'),
      userEntry('4', '<command-message>run</command-message>'),
      userEntry('5', '  <system-reminder>leading whitespace</system-reminder>'),
    ];
    expect(deriveContextHistory(entries)).toEqual(['real message']);
  });

  it('uniques exact-duplicate entries, keeping only the newest occurrence, without reordering', () => {
    const entries: TranscriptEntry[] = [
      userEntry('1', 'repeat'),
      userEntry('2', 'middle'),
      userEntry('3', 'repeat'),
      userEntry('4', 'newest'),
    ];
    // 新しい順に見て初出のみ残す: newest, repeat(#3), middle。#1のrepeatは重複として捨てられる
    // （「後勝ちで先頭へ繰り上げる」動作ではないため、repeatはmiddleより後ろのまま）。
    expect(deriveContextHistory(entries)).toEqual(['newest', 'repeat', 'middle']);
  });

  it('caps the result at 50 entries', () => {
    const entries: TranscriptEntry[] = Array.from({ length: 60 }, (_, i) => userEntry(String(i), `msg-${i}`));
    const result = deriveContextHistory(entries);
    expect(result).toHaveLength(50);
    expect(result[0]).toBe('msg-59');
    expect(result[49]).toBe('msg-10');
  });

  it('returns an empty array for no entries', () => {
    expect(deriveContextHistory([])).toEqual([]);
  });
});
