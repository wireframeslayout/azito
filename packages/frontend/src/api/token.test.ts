import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

const KEY = 'azito_ui_token';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const TTL_MS = 60 * DAY_MS;

let local: FakeStorage;
let session: FakeStorage;

function storedExpiresAt(): number {
  return (JSON.parse(local.getItem(KEY)!) as { expiresAt: number }).expiresAt;
}

describe('ui token storage', () => {
  beforeEach(() => {
    vi.resetModules();
    local = new FakeStorage();
    session = new FakeStorage();
    (globalThis as unknown as { localStorage: Storage }).localStorage = local as unknown as Storage;
    (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = session as unknown as Storage;
    (globalThis as unknown as { window: EventTarget }).window = new EventTarget();
  });

  it('setUiToken で保存したトークンを getUiToken で読み出せる', async () => {
    const { setUiToken, getUiToken } = await import('./token');
    setUiToken('tok');
    expect(getUiToken()).toBe('tok');
  });

  it('60 日経過後は空文字を返し、保存も消す', async () => {
    const { setUiToken, getUiToken } = await import('./token');
    setUiToken('tok');
    expect(getUiToken(Date.now() + TTL_MS + DAY_MS)).toBe('');
    expect(local.getItem(KEY)).toBeNull();
  });

  it('1 時間以上経過した読み出しで期限が延長される', async () => {
    const { setUiToken, getUiToken } = await import('./token');
    setUiToken('tok');
    const before = storedExpiresAt();
    const later = Date.now() + 2 * HOUR_MS;
    expect(getUiToken(later)).toBe('tok');
    expect(storedExpiresAt()).toBe(later + TTL_MS);
    expect(storedExpiresAt()).toBeGreaterThan(before);
  });

  it('1 時間未満では期限を延長しない', async () => {
    const { setUiToken, getUiToken } = await import('./token');
    setUiToken('tok');
    const before = storedExpiresAt();
    expect(getUiToken(Date.now() + 10 * 60 * 1000)).toBe('tok');
    expect(storedExpiresAt()).toBe(before);
  });

  it('sessionStorage の旧トークンを localStorage へ移行する', async () => {
    session.setItem(KEY, 'legacy');
    const { getUiToken } = await import('./token');
    expect(getUiToken()).toBe('legacy');
    expect(session.getItem(KEY)).toBeNull();
    expect(local.getItem(KEY)).not.toBeNull();
  });

  it('localStorage に既にある場合は sessionStorage から移行しない', async () => {
    const { setUiToken } = await import('./token');
    setUiToken('current');
    vi.resetModules();
    session.setItem(KEY, 'legacy');
    const { getUiToken } = await import('./token');
    expect(getUiToken()).toBe('current');
    expect(session.getItem(KEY)).toBe('legacy');
  });

  it('壊れた JSON は消して空文字を返す', async () => {
    local.setItem(KEY, '{not json');
    const { getUiToken } = await import('./token');
    expect(getUiToken()).toBe('');
    expect(local.getItem(KEY)).toBeNull();
  });

  it('expiresAt が数値でない場合は消して空文字を返す', async () => {
    local.setItem(KEY, JSON.stringify({ token: 'tok', expiresAt: 'soon' }));
    const { getUiToken } = await import('./token');
    expect(getUiToken()).toBe('');
    expect(local.getItem(KEY)).toBeNull();
  });

  it('localStorage が使えない環境で再読み込みしてもトークンが消えない', async () => {
    const throwingLocal = new FakeStorage();
    const origSet = throwingLocal.setItem.bind(throwingLocal);
    throwingLocal.setItem = (_key: string, _value: string) => {
      throw new DOMException('QuotaExceededError');
    };
    (globalThis as unknown as { localStorage: Storage }).localStorage = throwingLocal as unknown as Storage;
    const { setUiToken } = await import('./token');
    setUiToken('tok');
    expect(session.getItem(KEY)).not.toBeNull();

    vi.resetModules();
    const freshThrowingLocal = new FakeStorage();
    freshThrowingLocal.setItem = () => { throw new DOMException('QuotaExceededError'); };
    (globalThis as unknown as { localStorage: Storage }).localStorage = freshThrowingLocal as unknown as Storage;
    (globalThis as unknown as { window: EventTarget }).window = new EventTarget();
    const { getUiToken: getUiToken2 } = await import('./token');
    expect(getUiToken2()).toBe('tok');
    expect(session.getItem(KEY)).not.toBeNull();
  });

  it('clearUiToken は localStorage と sessionStorage の両方を消す', async () => {
    const { setUiToken, clearUiToken, hasUiToken } = await import('./token');
    setUiToken('tok');
    session.setItem(KEY, 'legacy');
    clearUiToken();
    expect(local.getItem(KEY)).toBeNull();
    expect(session.getItem(KEY)).toBeNull();
    expect(hasUiToken()).toBe(false);
  });
});
