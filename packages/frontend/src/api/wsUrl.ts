import { getUiToken } from './token';

export function buildWsUrl(params: Record<string, string>): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const searchParams = new URLSearchParams(params);
  const token = getUiToken();
  if (token) searchParams.set('token', token);
  return `${protocol}//${location.host}/ws?${searchParams}`;
}
