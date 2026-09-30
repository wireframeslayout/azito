const STORAGE_KEY = 'azito_ui_token';
const TTL_MS = 60 * 24 * 60 * 60 * 1000;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

interface StoredToken {
  token: string;
  expiresAt: number;
}

let migrated = false;

function parseStored(raw: string, now: number): StoredToken | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const { token, expiresAt } = parsed as Record<string, unknown>;
      if (typeof token === 'string' && token !== '' && typeof expiresAt === 'number' && expiresAt > now) {
        return { token, expiresAt };
      }
    }
  } catch {
    // corrupted — fall through to return null
  }
  return null;
}

function readStored(now: number): StoredToken | null {
  const raw = localStorage.getItem(STORAGE_KEY) ?? sessionStorage.getItem(STORAGE_KEY);
  if (raw === null) return null;
  const entry = parseStored(raw, now);
  if (entry === null) {
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
  }
  return entry;
}

function write(entry: StoredToken): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // localStorage unavailable (quota / privacy mode): keep the token for this tab only
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  }
}

function migrateFromSessionStorage(now: number): void {
  if (migrated) return;
  migrated = true;
  const legacy = sessionStorage.getItem(STORAGE_KEY);
  if (legacy === null || localStorage.getItem(STORAGE_KEY) !== null) return;
  // Only migrate old-format bare tokens; new-format JSON is not a migration candidate
  if (parseStored(legacy, now) !== null) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: legacy, expiresAt: now + TTL_MS }));
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable — leave sessionStorage intact for this tab
  }
}

export function getUiToken(now: number = Date.now()): string {
  migrateFromSessionStorage(now);
  const stored = readStored(now);
  if (stored === null) return '';
  if (stored.expiresAt - TTL_MS + REFRESH_INTERVAL_MS < now) {
    write({ token: stored.token, expiresAt: now + TTL_MS });
  }
  return stored.token;
}

export function setUiToken(token: string): void {
  write({ token, expiresAt: Date.now() + TTL_MS });
  window.dispatchEvent(new Event('azito:token-changed'));
}

export function clearUiToken(): void {
  localStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event('azito:token-changed'));
}

export function hasUiToken(): boolean {
  return getUiToken() !== '';
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) window.dispatchEvent(new Event('azito:token-changed'));
  });
}
