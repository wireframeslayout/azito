import crypto from 'crypto';

export function createTokenVerifier(token: string): (authHeader: string | undefined) => boolean {
  const tokenBuffer = Buffer.from(token);

  return (authHeader: string | undefined): boolean => {
    if (!authHeader) return false;
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') return false;
    const provided = Buffer.from(parts[1]);
    if (provided.length !== tokenBuffer.length) return false;
    return crypto.timingSafeEqual(provided, tokenBuffer);
  };
}
