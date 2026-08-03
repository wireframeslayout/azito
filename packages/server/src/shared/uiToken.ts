import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export function resolveUiToken(tokenPath: string): string {
  const envToken = process.env.AZITO_UI_TOKEN;
  if (envToken) return envToken;

  if (fs.existsSync(tokenPath)) {
    try { fs.chmodSync(tokenPath, 0o600); } catch {}
    const token = fs.readFileSync(tokenPath, 'utf-8').trim();
    if (token) return token;
  }

  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });

  if (process.stdout.isTTY) {
    console.log(`[ui-token] Generated new UI token: ${token}`);
    console.log(`[ui-token] Set AZITO_UI_TOKEN env to use a fixed token, or find it at ${tokenPath}`);
  } else {
    console.log(`[ui-token] Generated new UI token. Read it from: ${tokenPath}`);
  }

  return token;
}
