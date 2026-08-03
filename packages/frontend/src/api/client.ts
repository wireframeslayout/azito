import { getUiToken, clearUiToken } from './token';

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
  return res.json();
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
  return res.json();
}
