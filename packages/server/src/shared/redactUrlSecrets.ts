const SECRET_QUERY_KEYS = new Set(['token']);
const REDACTED = '[REDACTED]';

export function redactUrlSecrets(url: string): string {
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return url;
  const hashIndex = url.indexOf('#', qIndex);
  const queryEnd = hashIndex === -1 ? url.length : hashIndex;
  const parts = url.slice(qIndex + 1, queryEnd).split('&');
  let changed = false;
  const redacted = parts.map((part) => {
    const eq = part.indexOf('=');
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      // malformed escape: compare the raw key
    }
    if (!SECRET_QUERY_KEYS.has(key)) return part;
    changed = true;
    return `${rawKey}=${REDACTED}`;
  });
  if (!changed) return url;
  return `${url.slice(0, qIndex + 1)}${redacted.join('&')}${url.slice(queryEnd)}`;
}
