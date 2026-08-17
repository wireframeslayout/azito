import fs from 'fs';
import { resolveDataDir } from './dataDir';
import { readEnvValue, resolveServerEnvPath } from './envFile';

export interface CurrentUiToken {
  token: string;
  source: string;
}

// ─── Current hub UI token resolution (local machine only) ───
//
// Mirrors the same env -> .env -> ui-token-file precedence the running
// server applies (see main.ts's resolveUiToken call). Used by both
// `azito token show` and `azito auth doctor` — extracted here so the two
// commands can't drift on what "the current token" means.
export function resolveCurrentUiToken(): CurrentUiToken | null {
  const envToken = process.env.AZITO_UI_TOKEN;
  if (envToken) return { token: envToken, source: 'env' };

  const envFilePath = resolveServerEnvPath();
  const dotenvToken = readEnvValue(envFilePath, 'AZITO_UI_TOKEN');
  if (dotenvToken) return { token: dotenvToken, source: envFilePath };

  const paths = resolveDataDir();
  if (fs.existsSync(paths.uiToken)) {
    const fileToken = fs.readFileSync(paths.uiToken, 'utf-8').trim();
    if (fileToken) return { token: fileToken, source: paths.uiToken };
  }

  return null;
}
