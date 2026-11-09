import { apiWithStatus } from './client';

export async function apiOk<T>(path: string, options?: RequestInit): Promise<T> {
  const { status, body } = await apiWithStatus<T>(path, options);
  if (status < 200 || status >= 300) throw new Error(`Request failed (HTTP ${status})`);
  return body;
}
