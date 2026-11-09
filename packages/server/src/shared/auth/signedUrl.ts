import { createHmac, timingSafeEqual } from 'node:crypto';

interface SignedClaims { scope: string; sub: string; exp: number }

/** Signs a target and expiry with a key derived by the application wiring. */
export function signUrlToken(key: Buffer, scope: string, sub: string, expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ scope, sub, exp: expiresAt })).toString('base64url');
  const signature = createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

/** Returns the target only when signature, scope and expiry all match. */
export function verifyUrlToken(key: Buffer, token: string, scope: string, now: number): string | null {
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
  const actual = Buffer.from(parts[1], 'base64url');
  const expected = createHmac('sha256', key).update(parts[0]).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object') return null;
    const claims = value as Partial<SignedClaims>;
    return claims.scope === scope && typeof claims.sub === 'string' && claims.sub.length > 0 && Number.isSafeInteger(claims.exp) && claims.exp! > now ? claims.sub : null;
  } catch {
    return null;
  }
}
