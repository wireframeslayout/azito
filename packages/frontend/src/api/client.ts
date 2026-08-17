import { getUiToken, clearUiToken } from './token';
import { isOperatorRequiredError, reportIfOperatorRequired } from './operatorRequired';

export async function api<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const token = getUiToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`/api${path}`, {
    ...options,
    headers,
  });
  if (res.status === 401) {
    clearUiToken();
    throw new Error('Unauthorized');
  }
  const body = await res.json();
  if (isOperatorRequiredError(res.status, body)) {
    reportIfOperatorRequired(res.status, body);
    // The stored token is task-shaped, not the operator's `AZITO_UI_TOKEN`
    // (see operatorRequired.ts) — clear it and drop back to TokenGate, same
    // as the 401 branch above, so the caller never treats this 403 body as
    // a success value.
    clearUiToken();
    throw new Error('OperatorRequired');
  }
  return body;
}

/**
 * api() と同じ呼び出し規約だが、レスポンスの HTTP ステータスも返す。
 * 呼び出し元が「404（見つからない）」と「その他のエラー（一時的な 500 等）」を区別したい場合に使う。
 * api() の既存挙動（ステータス無視で body を返す）は変更しない。
 */
export async function apiWithStatus<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<{ status: number; body: T }> {
  const token = getUiToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`/api${path}`, {
    ...options,
    headers,
  });
  if (res.status === 401) {
    clearUiToken();
    throw new Error('Unauthorized');
  }
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

export async function fetchBlob(path: string): Promise<Blob> {
  const token = getUiToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { headers });
  if (res.status === 401) {
    clearUiToken();
    throw new Error('Unauthorized');
  }
  if (res.status === 403) {
    // Body may or may not be JSON-parseable; clone so a failed parse never
    // consumes the stream the `!res.ok` branch below still needs.
    try {
      reportIfOperatorRequired(res.status, await res.clone().json());
    } catch {
      // Not a JSON body — not an operator_required response, nothing to report.
    }
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch file: ${res.status}`);
  }
  return res.blob();
}

export async function uploadFile<T = unknown>(
  path: string,
  file: File,
): Promise<T> {
  const token = getUiToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    body: form,
    headers,
  });
  if (res.status === 401) {
    clearUiToken();
    throw new Error('Unauthorized');
  }
  const body = await res.json();
  if (isOperatorRequiredError(res.status, body)) {
    reportIfOperatorRequired(res.status, body);
    clearUiToken();
    throw new Error('OperatorRequired');
  }
  return body;
}
