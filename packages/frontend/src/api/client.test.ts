import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vitest.config.ts` runs this suite under `environment: 'node'`, so
// `window`/`sessionStorage` don't exist as ambient globals the way they do
// in a browser — `api/token.ts` and `api/operatorRequired.ts` both touch
// `window.dispatchEvent`/`sessionStorage` at call time (not at module load),
// so stubbing them before each test is enough; no jsdom needed.
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

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    clone() {
      return jsonResponse(status, body);
    },
    blob: async () => new Blob(),
  } as unknown as Response;
}

describe('api()', () => {
  beforeEach(() => {
    (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = new FakeStorage() as unknown as Storage;
    (globalThis as unknown as { window: EventTarget }).window = new EventTarget();
    globalThis.fetch = vi.fn();
  });

  it('operator_required の 403 は絶対に成功値として resolve しない', async () => {
    const { setUiToken } = await import('./token');
    const { api } = await import('./client');
    setUiToken('azt.task.abc123.secret');
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(403, { error: 'operator_required', operation: 'units.execute' }),
    );

    await expect(api('/units/1/execute', { method: 'POST' })).rejects.toThrow();
  });

  it('operator_required の 403 を受けると保存済みトークンをクリアする（TokenGate 再表示のため）', async () => {
    const { setUiToken, getUiToken } = await import('./token');
    const { api } = await import('./client');
    setUiToken('azt.task.abc123.secret');
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(403, { error: 'operator_required', operation: 'units.execute' }),
    );

    await expect(api('/units/1/execute', { method: 'POST' })).rejects.toThrow();
    expect(getUiToken()).toBe('');
  });

  it('通常の 200 応答は成功値として resolve する', async () => {
    const { api } = await import('./client');
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(200, { ok: true }));

    await expect(api('/health')).resolves.toEqual({ ok: true });
  });
});

describe('uploadFile()', () => {
  beforeEach(() => {
    (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = new FakeStorage() as unknown as Storage;
    (globalThis as unknown as { window: EventTarget }).window = new EventTarget();
    globalThis.fetch = vi.fn();
  });

  it('operator_required の 403 は絶対に成功値として resolve しない', async () => {
    const { setUiToken, getUiToken } = await import('./token');
    const { uploadFile } = await import('./client');
    setUiToken('azt.task.abc123.secret');
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(403, { error: 'operator_required', operation: 'files.upload' }),
    );

    const file = new File(['x'], 'x.txt');
    await expect(uploadFile('/files/upload', file)).rejects.toThrow();
    expect(getUiToken()).toBe('');
  });
});
