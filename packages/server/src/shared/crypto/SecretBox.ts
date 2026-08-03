import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

let keyPath: string | null = null;
let cachedKey: Buffer | null = null;

export function initSecretBox(masterKeyPath: string): void {
  keyPath = masterKeyPath;
  cachedKey = null;
}

export function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const envKey = process.env.AZITO_MASTER_KEY;
  if (envKey) {
    if (!/^[0-9a-fA-F]{64}$/.test(envKey)) {
      throw new Error('AZITO_MASTER_KEY must be 64 hex characters (32 bytes)');
    }
    cachedKey = Buffer.from(envKey, 'hex');
    return cachedKey;
  }

  if (!keyPath) {
    throw new Error('SecretBox not initialized. Call initSecretBox(path) before using seal/open.');
  }

  if (fs.existsSync(keyPath)) {
    try { fs.chmodSync(keyPath, 0o600); } catch {}
    const hex = fs.readFileSync(keyPath, 'utf-8').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('master.key must contain 64 hex characters (32 bytes)');
    }
    cachedKey = Buffer.from(hex, 'hex');
    return cachedKey;
  }

  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 });
  cachedKey = key;
  return cachedKey;
}

export function seal(plain: string | null | undefined): string | null {
  if (plain == null) return null;

  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

export function open(sealed: string | null | undefined): string | null {
  if (sealed == null) return null;

  if (!sealed.startsWith('v1.')) {
    return sealed;
  }

  const parts = sealed.split('.');
  if (parts.length !== 4) {
    throw new Error('Invalid sealed format');
  }

  const key = getMasterKey();
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const encrypted = Buffer.from(parts[3], 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
