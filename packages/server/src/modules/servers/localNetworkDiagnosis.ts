import { isIP } from 'node:net';

export const LOCAL_NETWORK_PERMISSION_CODE = 'macos_local_network_permission';

/** Diagnose only when both the failing IP and the socket errno are known. */
export function isPossibleLocalNetworkPermission(platform: string, isLaunchd: boolean, address: string | undefined, code: string | undefined): boolean {
  if (platform !== 'darwin' || !isLaunchd || !address || (code !== 'EHOSTUNREACH' && code !== 'ENETUNREACH')) return false;
  const ip = address.split('%')[0]!;
  if (address.includes('%') && isIP(ip) !== 6) return false;
  const family = isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPrivateV4(mapped[1]!);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (mappedHex) {
    const high = parseInt(mappedHex[1]!, 16);
    const low = parseInt(mappedHex[2]!, 16);
    return isPrivateV4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  const pieces = ip.split('::');
  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces[1] ? pieces[1].split(':') : [];
  const groups = pieces.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  if (groups.length === 8 && groups.slice(0, 5).every((v) => parseInt(v, 16) === 0) && parseInt(groups[5]!, 16) === 0xffff) {
    const high = parseInt(groups[6]!, 16);
    const low = parseInt(groups[7]!, 16);
    return isPrivateV4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  const first = parseInt(groups[0]!, 16);
  if (first === 0xfd7a && parseInt(groups[1]!, 16) === 0x115c && parseInt(groups[2]!, 16) === 0xa1e0) return false;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export class LocalNetworkPermissionError extends Error {
  readonly code = LOCAL_NETWORK_PERMISSION_CODE;
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'LocalNetworkPermissionError';
  }
}

export function diagnoseLocalNetworkError(err: unknown, platform: string, isLaunchd: boolean): unknown {
  const pending: unknown[] = [err];
  const seen = new Set<unknown>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const value = current as { code?: unknown; address?: unknown; cause?: unknown; errors?: unknown; message?: unknown };
    if (isPossibleLocalNetworkPermission(platform, isLaunchd, typeof value.address === 'string' ? value.address : undefined, typeof value.code === 'string' ? value.code : undefined)) {
      return new LocalNetworkPermissionError(typeof value.message === 'string' ? value.message : String(err));
    }
    pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors);
  }
  return err;
}
