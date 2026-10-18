import webpush from 'web-push';
import fs from 'fs';
import type { SecretFileGuard } from '../../../shared/os/secretFileGuard';

let keyPath: string | null = null;
let secretFileGuard: SecretFileGuard | null = null;

export function initVapidKeyManager(vapidKeysPath: string, guard: SecretFileGuard): void {
  keyPath = vapidKeysPath;
  secretFileGuard = guard;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export function getVapidKeys(): VapidKeys {
  if (!keyPath || !secretFileGuard) {
    throw new Error('VapidKeyManager not initialized. Call initVapidKeyManager(path) first.');
  }

  if (fs.existsSync(keyPath)) {
    secretFileGuard.repairFile(keyPath);
    return JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
  }
  const keys = webpush.generateVAPIDKeys();
  secretFileGuard.writeSecretFile(keyPath, JSON.stringify(keys, null, 2));
  return keys;
}
