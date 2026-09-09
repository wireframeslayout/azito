import { ISOLATION_MASKED_ENV } from './isolationMaskedEnv';

export function uiTokenEnv(uiToken: string): Record<string, string> {
  return uiToken ? { AZITO_UI_TOKEN: uiToken } : {};
}

export function uiTokenEnvForServer(uiToken: string, server: { isolationIntent: boolean }): Record<string, string> {
  if (server.isolationIntent) return { ...ISOLATION_MASKED_ENV };
  return uiTokenEnv(uiToken);
}
