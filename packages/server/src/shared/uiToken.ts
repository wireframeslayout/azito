import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

function resolvePersistedToken(envVar: string, filePath: string): string {
  const envToken = process.env[envVar];
  if (envToken) return envToken;

  if (fs.existsSync(filePath)) {
    try { fs.chmodSync(filePath, 0o600); } catch {}
    const token = fs.readFileSync(filePath, 'utf-8').trim();
    if (token) {
      console.log(`[${path.basename(filePath)}] Using persisted token at ${filePath}`);
      return token;
    }
  }

  const tag = path.basename(filePath);
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, token, { mode: 0o600 });

  if (process.stdout.isTTY) {
    console.log(`[${tag}] Generated new token: ${token}`);
    console.log(`[${tag}] Set ${envVar} env to use a fixed token, or find it at ${filePath}`);
  } else {
    console.log(`[${tag}] Generated new token. Read it from: ${filePath}`);
  }

  return token;
}

export function resolveUiToken(tokenPath: string): string {
  return resolvePersistedToken('AZITO_UI_TOKEN', tokenPath);
}

export function resolveWebhookToken(tokenPath: string): string {
  return resolvePersistedToken('AZITO_WEBHOOK_TOKEN', tokenPath);
}
