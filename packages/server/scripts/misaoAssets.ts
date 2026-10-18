import { execFileSync } from 'child_process';
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
 *
 * misao is one native binary per target (the Node `.mjs` build is not shipped). Every hub tarball carries all four Unix
 * targets, whatever platform it is built for: the hub installs its own misao from it (hubs run on linux x64 / arm64 and
 * darwin arm64), and the same bundle shape serves an agent server whose OS / architecture differs. The one that fits the
 * install target is picked at install time. (The agent installer's preflight currently accepts x86_64 hosts only; agent
 * support for other architectures is a separate matter and does not change what is bundled.)
 */
export const MISAO_RELEASE = {
  version: '0.3.0',
  baseUrl: 'https://github.com/wireframeslayout/misao/releases/download/v0.3.0',
  assets: {
    'misao-0.3.0-x86_64-unknown-linux-musl.tar.gz': '564000c5a240cf60a6192f2b9253249bdc3b34061179c51a1000856837d9003a',
    'misao-0.3.0-aarch64-unknown-linux-musl.tar.gz': '574e960e1022b582b1ae2604bd8d6126a8e8e55fc9680a10d8e762d07f36a754',
    'misao-0.3.0-aarch64-apple-darwin.tar.gz': '93d87feb08a07cf65841bf16fbb4df817d6a59f32a04d8bab76ff4f7e845719a',
    'misao-0.3.0-x86_64-apple-darwin.tar.gz': 'c6b4066db0bad4897d25538ba8994ce1965fb001a3272f5324a83eb7112f8b4c',
  },
} as const;

export type MisaoAssetName = keyof typeof MISAO_RELEASE.assets;

/** The files an archive carries directly under its top directory (`misao-<ver>-<target>/`). */
export const MISAO_RELEASE_FILES = ['misao', 'LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.txt'] as const;
export type MisaoReleaseFile = typeof MISAO_RELEASE_FILES[number];

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
      `  ${Object.keys(MISAO_RELEASE.assets).join(', ')} from ${MISAO_RELEASE.baseUrl}/\n` +
      `  and set ${MISAO_ASSET_DIR_ENV} to the directory holding them (they are verified against the pinned sha256).`,
    );
  }
  return cached;
}

/** `misao/manifest.json` in the hub bundle: which misao the bundle carries (read by MisaoBundle at runtime). */
export interface MisaoManifest {
  version: string;
  /** Per target triple: the sha256 of each file under `misao/<target>/`. */
  targets: Record<string, Record<MisaoReleaseFile, string>>;
}

/** Extracts one pinned archive (verified against its sha256) into `destDir`, flat (the archive's top directory is stripped). */
async function extractAsset(asset: MisaoAssetName, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  // `misao-<ver>-<target>/` is the archive's only top directory.
  execFileSync('tar', ['xzf', await resolveAsset(asset), '-C', destDir, '--strip-components=1']);
}

/**
 * The pinned native binary of one target, extracted into `destDir` and returned as a path (for CI and tests that need a real
 * misao: the same version, URL and sha256 as the hub ships). A target without a pinned archive is an error.
 */
export async function fetchMisaoBinary(target: string, destDir: string): Promise<string> {
  const asset = (Object.keys(MISAO_RELEASE.assets) as MisaoAssetName[]).find((name) => targetOf(name) === target);
  if (!asset) throw new Error(`no pinned misao ${MISAO_RELEASE.version} archive for target ${target}`);
  await extractAsset(asset, destDir);
  return path.join(destDir, 'misao');
}

function targetOf(asset: MisaoAssetName): string {
  return asset.slice(`misao-${MISAO_RELEASE.version}-`.length, -'.tar.gz'.length);
}

/** Stages `misao/<target>/{misao,LICENSE,NOTICE,THIRD-PARTY-LICENSES.txt}` for every target, plus `misao/manifest.json`, into the hub bundle. */
export async function stageMisao(stageDir: string): Promise<void> {
  const dest = path.join(stageDir, 'misao');
  fs.mkdirSync(dest, { recursive: true });

  const manifest: MisaoManifest = { version: MISAO_RELEASE.version, targets: {} };
  for (const asset of Object.keys(MISAO_RELEASE.assets) as MisaoAssetName[]) {
    const target = targetOf(asset);
    const targetDir = path.join(dest, target);
    await extractAsset(asset, targetDir);

    const hashes = {} as Record<MisaoReleaseFile, string>;
    for (const name of MISAO_RELEASE_FILES) {
      const file = path.join(targetDir, name);
      if (!fs.existsSync(file)) throw new Error(`${asset} does not contain ${name}`);
      hashes[name] = sha256(file);
    }
    fs.chmodSync(path.join(targetDir, 'misao'), 0o755);
    manifest.targets[target] = hashes;
  }
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
