import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { SecretFileGuard } from './os/secretFileGuard';

function resolvePersistedToken(envVar: string, filePath: string, guard: SecretFileGuard): string {
  const envToken = process.env[envVar];
  if (envToken) return envToken;

  if (fs.existsSync(filePath)) {
    guard.repairFile(filePath);
    const token = fs.readFileSync(filePath, 'utf-8').trim();
    if (token) {
      console.log(`[${path.basename(filePath)}] Using persisted token at ${filePath}`);
      return token;
    }
  }

  const tag = path.basename(filePath);
  const token = crypto.randomBytes(32).toString('hex');
  guard.writeSecretFile(filePath, token);

  if (process.stdout.isTTY) {
    console.log(`[${tag}] Generated new token: ${token}`);
    console.log(`[${tag}] Set ${envVar} env to use a fixed token, or find it at ${filePath}`);
  } else {
    console.log(`[${tag}] Generated new token. Read it from: ${filePath}`);
  }

  return token;
}

export function resolveUiToken(tokenPath: string, guard: SecretFileGuard): string {
  return resolvePersistedToken('AZITO_UI_TOKEN', tokenPath, guard);
}

export function resolveWebhookToken(tokenPath: string, guard: SecretFileGuard): string {
  return resolvePersistedToken('AZITO_WEBHOOK_TOKEN', tokenPath, guard);
}
