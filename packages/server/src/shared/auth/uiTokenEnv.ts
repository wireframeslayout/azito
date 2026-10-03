import { ISOLATION_HUB_SECRET_MASK } from './isolationMaskedEnv';

export function uiTokenEnv(uiToken: string): Record<string, string> {
  return uiToken ? { AZITO_UI_TOKEN: uiToken } : {};
}

export function uiTokenEnvForServer(uiToken: string, server: { isolationIntent: boolean }): Record<string, string> {
  if (server.isolationIntent) return { ...ISOLATION_HUB_SECRET_MASK };
  return uiTokenEnv(uiToken);
}
