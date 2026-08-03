const STORAGE_KEY = 'azito_ui_token';

export function getUiToken(): string {
  return sessionStorage.getItem(STORAGE_KEY) ?? '';
}

export function setUiToken(token: string): void {
  sessionStorage.setItem(STORAGE_KEY, token);
  window.dispatchEvent(new Event('azito:token-changed'));
}

export function clearUiToken(): void {
  sessionStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event('azito:token-changed'));
}

export function hasUiToken(): boolean {
  return !!sessionStorage.getItem(STORAGE_KEY);
}
