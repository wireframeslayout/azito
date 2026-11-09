const SETTINGS_CHANGED = 'azito:lookout-settings-changed';

export function notifyLookoutSettingsChanged(): void {
  window.dispatchEvent(new Event(SETTINGS_CHANGED));
}

export function subscribeLookoutSettingsChanged(listener: () => void): () => void {
  window.addEventListener(SETTINGS_CHANGED, listener);
  return () => window.removeEventListener(SETTINGS_CHANGED, listener);
}
