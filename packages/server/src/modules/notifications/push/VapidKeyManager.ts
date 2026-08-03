import webpush from 'web-push';
import fs from 'fs';
import path from 'path';

let keyPath: string | null = null;

export function initVapidKeyManager(vapidKeysPath: string): void {
  keyPath = vapidKeysPath;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export function getVapidKeys(): VapidKeys {
  if (!keyPath) {
    throw new Error('VapidKeyManager not initialized. Call initVapidKeyManager(path) first.');
  }

  if (fs.existsSync(keyPath)) {
    try { fs.chmodSync(keyPath, 0o600); } catch {}
    return JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
  }
  const keys = webpush.generateVAPIDKeys();
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}
