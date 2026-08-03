import fs from 'fs';
import path from 'path';

export interface ReleaseInfo {
  version: string;
  commit: string;
  bundleHash: string;
  channel: { repo: string };
}

let cached: ReleaseInfo | null | undefined;
let cachedBundleRoot: string | null | undefined;

function detectBasePath(): string {
  return path.dirname(process.argv[1] || __dirname);
}

export function getReleaseInfo(basePath?: string): ReleaseInfo | null {
  if (cached !== undefined && basePath === undefined) return cached;
  const base = basePath ?? detectBasePath();
  const releaseJsonPath = path.join(base, 'release.json');
  try {
    const content = fs.readFileSync(releaseJsonPath, 'utf-8');
    const info = JSON.parse(content) as ReleaseInfo;
    if (!basePath) {
      cached = info;
      cachedBundleRoot = base;
    }
    return info;
  } catch {
    if (!basePath) {
      cached = null;
      cachedBundleRoot = null;
    }
    return null;
  }
}

export function isReleaseMode(basePath?: string): boolean {
  return getReleaseInfo(basePath) !== null;
}

export function getBundleRoot(basePath?: string): string | null {
  if (basePath) return isReleaseMode(basePath) ? basePath : null;
  if (cachedBundleRoot !== undefined) return cachedBundleRoot;
  getReleaseInfo();
  return cachedBundleRoot ?? null;
}

// packages/server/src/shared → src → server → packages → repo root
const SOURCE_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

export function resolveRoot(): string {
  return getBundleRoot() ?? SOURCE_ROOT;
}

export function _resetCache(): void {
  cached = undefined;
  cachedBundleRoot = undefined;
}
