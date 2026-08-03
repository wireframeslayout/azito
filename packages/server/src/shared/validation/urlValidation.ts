import dns from 'dns/promises';
import { URL } from 'url';

function isPrivateIp(ip: string): boolean {
  if (ip === '0.0.0.0' || ip === '::' || ip === '::1') return true;
  if (ip.startsWith('127.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith('100.')) {
    const second = parseInt(ip.split('.')[1], 10);
    if (second >= 64 && second <= 127) return true;
  }
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true;
  return false;
}

export async function validateCustomBaseUrl(rawUrl: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'Invalid URL format';
  }
  if (url.protocol !== 'https:') return 'base_url must use HTTPS';

  try {
    const { address } = await dns.lookup(url.hostname);
    if (isPrivateIp(address)) return 'base_url must not resolve to a private or loopback address';
  } catch {
    return `DNS lookup failed for ${url.hostname}`;
  }

  return null;
}
