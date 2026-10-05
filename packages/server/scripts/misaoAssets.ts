import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * The misao release the hub ships. Bumping it is a deliberate change here:
 * version, URL and sha256 are pinned together, so a build never picks up an
 * asset that was swapped on the release page (SHA256SUMS from the same origin
 * would prove nothing). The SDK / protocol tarballs in packages/server/package.json
 * must point at the same version.
 */
export const MISAO_RELEASE = {
  version: '0.2.0',
  baseUrl: 'https://github.com/wireframeslayout/misao/releases/download/v0.2.0',
  assets: {
    'misao-0.2.0.mjs': 'a418714fd7b38f4235766e0d1e082d83ec46081b193ce5964ad00910d84b5c89',
    'misao-0.2.0.LICENSES.txt': '3a3696bba2f4c3cbcb0d51bf6336c0a63f0eeb5a0212aad0ce768905ffc82306',
  },
} as const;

export type MisaoAssetName = keyof typeof MISAO_RELEASE.assets;

/** Where downloaded assets are cached between builds (dist-hub is wiped on every build, so not there). */
const DEFAULT_CACHE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'misao');

/** A directory holding the release assets by their original names, for builds without network access. */
export const MISAO_ASSET_DIR_ENV = 'AZITO_MISAO_ASSET_DIR';

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hasExpectedHash(file: string, expected: string): boolean {
  return fs.existsSync(file) && sha256(file) === expected;
}

async function download(name: MisaoAssetName, dest: string): Promise<void> {
  const url = `${MISAO_RELEASE.baseUrl}/${name}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`could not download ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`could not download ${url}: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const actual = crypto.createHash('sha256').update(body).digest('hex');
  const expected = MISAO_RELEASE.assets[name];
  if (actual !== expected) {
    throw new Error(`sha256 mismatch for ${name}: expected ${expected}, got ${actual}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, dest);
}

/**
 * Resolves one pinned asset to a verified local file: the offline directory
 * (AZITO_MISAO_ASSET_DIR) when set, otherwise the cache, otherwise the release
 * page. Every source is checked against the pinned sha256, and a failure is an
 * explicit error — a release without misao must never be built silently.
 */
async function resolveAsset(name: MisaoAssetName): Promise<string> {
  const expected = MISAO_RELEASE.assets[name];

  const offlineDir = process.env[MISAO_ASSET_DIR_ENV];
  if (offlineDir) {
    const file = path.join(offlineDir, name);
    if (!fs.existsSync(file)) {
      throw new Error(`${MISAO_ASSET_DIR_ENV}=${offlineDir} does not contain ${name}`);
    }
    if (!hasExpectedHash(file, expected)) {
      throw new Error(`${file} does not match the pinned sha256 ${expected}`);
    }
    return file;
  }

  const cached = path.join(DEFAULT_CACHE_DIR, name);
  if (hasExpectedHash(cached, expected)) return cached;
  try {
    await download(name, cached);
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n` +
      `  Fetching the misao ${MISAO_RELEASE.version} release failed. On a build host without network access, download\n` +
      `  ${Object.keys(MISAO_RELEASE.assets).join(' and ')} from ${MISAO_RELEASE.baseUrl}/\n` +
      `  and set ${MISAO_ASSET_DIR_ENV} to the directory holding them (they are verified against the pinned sha256).`,
    );
  }
  return cached;
}

/** `misao/manifest.json` in the hub bundle: which misao the bundle carries (read by MisaoBundle at runtime). */
export interface MisaoManifest {
  version: string;
  files: Record<'misao.mjs' | 'LICENSES.txt', string>;
}

/** Stages `misao/{misao.mjs,LICENSES.txt,manifest.json}` into the hub bundle. */
export async function stageMisao(stageDir: string): Promise<void> {
  const dest = path.join(stageDir, 'misao');
  fs.mkdirSync(dest, { recursive: true });

  const bundleName = `misao-${MISAO_RELEASE.version}.mjs` as MisaoAssetName;
  const licensesName = `misao-${MISAO_RELEASE.version}.LICENSES.txt` as MisaoAssetName;
  fs.copyFileSync(await resolveAsset(bundleName), path.join(dest, 'misao.mjs'));
  fs.copyFileSync(await resolveAsset(licensesName), path.join(dest, 'LICENSES.txt'));
  fs.chmodSync(path.join(dest, 'misao.mjs'), 0o755);

  const manifest: MisaoManifest = {
    version: MISAO_RELEASE.version,
    files: {
      'misao.mjs': MISAO_RELEASE.assets[bundleName],
      'LICENSES.txt': MISAO_RELEASE.assets[licensesName],
    },
  };
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
