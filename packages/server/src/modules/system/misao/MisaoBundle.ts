import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { MISAO_RELEASE_FILE_NAMES, type MisaoReleaseFile } from '../../servers/transport/agentMisaoSocket';
import { MisaoServiceError } from './MisaoServiceError';

/**
 * The targets a hub release carries a misao binary for. A hub runs on linux x64 / arm64 and darwin arm64 and installs its
 * own misao from the same bundle; the rest keeps the bundle one shape for every hub and covers an agent host of another
 * OS / architecture (AZITO's own agent installer currently accepts x86_64 only). The Windows build is installed by
 * `MisaoWindowsInstaller` (a logon task), on the hub's own machine and, through the agent, on a Windows agent host.
 */
export const MISAO_TARGETS = [
  'x86_64-unknown-linux-musl',
  'aarch64-unknown-linux-musl',
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
] as const;
export type MisaoTarget = typeof MISAO_TARGETS[number];

const TARGET_BY_PLATFORM: Record<string, Record<string, MisaoTarget>> = {
  linux: { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' },
  darwin: { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' },
  win32: { x64: 'x86_64-pc-windows-msvc' },
};

/**
 * The misao target for a host's OS and architecture (Node's `process.platform` / `process.arch` names, which is what an
 * agent reports). A host without a binary is an error: there is no fallback to some other build.
 */
export function misaoTargetFor(platform: string, arch: string): MisaoTarget {
  const archs = Object.hasOwn(TARGET_BY_PLATFORM, platform) ? TARGET_BY_PLATFORM[platform] : undefined;
  const target = archs && Object.hasOwn(archs, arch) ? archs[arch] : undefined;
  if (!target) {
    throw new MisaoServiceError('unsupported_host', `misao has no binary for ${platform}/${arch} (available: ${MISAO_TARGETS.join(', ')}).`);
  }
  return target;
}

/**
 * The name of a release file on disk under `misao/<target>/`. The manifest and `MisaoTargetFiles` key the executable by
 * the logical name `misao` for every target; on Windows it is the file `misao.exe`.
 */
export function misaoFileName(target: MisaoTarget, name: MisaoReleaseFile): string {
  return name === 'misao' && target.includes('-windows-') ? 'misao.exe' : name;
}

const sha256Field = z.string().regex(/^[0-9a-f]{64}$/);
const targetFilesSchema = z.object(Object.fromEntries(MISAO_RELEASE_FILE_NAMES.map((name) => [name, sha256Field])) as Record<MisaoReleaseFile, typeof sha256Field>);
const manifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  targets: z.object(Object.fromEntries(MISAO_TARGETS.map((target) => [target, targetFilesSchema])) as Record<MisaoTarget, typeof targetFilesSchema>),
});

/** The files of one target, where they are in the hub bundle and their sha256 from the manifest. */
export interface MisaoTargetFiles {
  target: MisaoTarget;
  files: Record<MisaoReleaseFile, string>;
  sha256: Record<MisaoReleaseFile, string>;
}

/** The misao a hub release carries: `<bundle>/misao/<target>/{misao (misao.exe on Windows),LICENSE,NOTICE,THIRD-PARTY-LICENSES.txt}` for each target, `manifest.json`, and the deploy templates. */
export interface MisaoBundle {
  version: string;
  /** `<bundle>/misao` */
  dir: string;
  templatesDir: string;
  targets: Record<MisaoTarget, MisaoTargetFiles>;
}

export function sha256Buffer(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function sha256File(file: string): string {
  return sha256Buffer(fs.readFileSync(file));
}

/** The files to install on a host of this OS / architecture; throws `unsupported_host` when the bundle has none for it. */
export function bundleFilesFor(bundle: MisaoBundle, platform: string, arch: string): MisaoTargetFiles {
  return bundle.targets[misaoTargetFor(platform, arch)];
}

/**
 * Reads the misao bundled with the running hub release. Null when this hub carries none (a source checkout, or a
 * release older than the bundling): then nothing can be installed from here. A bundle that is present but corrupt
 * (manifest does not parse, a file is missing or does not match its sha256) throws — shipping a damaged daemon
 * to a service must fail loudly.
 */
export function readMisaoBundle(bundleRoot: string | null): MisaoBundle | null {
  if (!bundleRoot) return null;
  const dir = path.join(bundleRoot, 'misao');
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;

  const manifest = manifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));
  const targets = {} as Record<MisaoTarget, MisaoTargetFiles>;
  for (const target of MISAO_TARGETS) {
    const files = {} as Record<MisaoReleaseFile, string>;
    for (const name of MISAO_RELEASE_FILE_NAMES) {
      const file = path.join(dir, target, misaoFileName(target, name));
      if (!fs.existsSync(file)) throw new Error(`The bundled misao is incomplete: ${file} is missing`);
      if (sha256File(file) !== manifest.targets[target][name]) {
        throw new Error(`The bundled misao is damaged: ${file} does not match its manifest sha256`);
      }
      files[name] = file;
    }
    targets[target] = { target, files, sha256: manifest.targets[target] };
  }
  return { version: manifest.version, dir, templatesDir: path.join(bundleRoot, 'deploy'), targets };
}
