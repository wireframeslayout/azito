import path from 'path';
import type { HostEnv } from '../../shared/os/hostEnv';
import { resolveInstallPrefix } from './misao/misaoPaths';

/** What the update needs to know about the machine the hub runs on, resolved once at the entry point (`HostEnv`) and the bundle's location. */
export interface HubInstallHost {
  platform: HostEnv['platform'];
  arch: HostEnv['arch'];
  /** The folder the running bundle lives in (`getBundleRoot()`); null for a source checkout. */
  bundleRoot: string | null;
}

/** The release asset names of the hub bundle: the archive for this OS and the checksum file. */
export interface HubAssetNames {
  archive: string;
  sums: 'SHA256SUMS';
}

/**
 * Throws when no release asset exists for this host. Linux and macOS keep the choice they always had (any other Node platform is
 * treated as Linux, any architecture but arm64 as x64); Windows has one asset, `win32-x64`, and any other Windows architecture is
 * refused with the reason, never given another OS's archive.
 */
export function assertSupportedHubHost(host: Pick<HubInstallHost, 'platform' | 'arch'>): void {
  if (host.platform === 'win32' && host.arch !== 'x64') {
    throw new Error(`There is no AZITO hub release for Windows on ${host.arch}: only win32-x64 is published`);
  }
}

export function hubAssetNames(tag: string, host: Pick<HubInstallHost, 'platform' | 'arch'>): HubAssetNames {
  assertSupportedHubHost(host);
  if (host.platform === 'win32') return { archive: `azito-hub-${tag}-win32-x64.zip`, sums: 'SHA256SUMS' };
  const platform = host.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = host.arch === 'arm64' ? 'arm64' : 'x64';
  return { archive: `azito-hub-${tag}-${platform}-${arch}.tar.gz`, sums: 'SHA256SUMS' };
}

/** Where the hub of this install lives, decided from where the running bundle is, not from where its data happens to be. */
export interface HubInstallPaths {
  /** `<prefix>`: the folder above `hub/` (`~/.azito` by default, or what `-Prefix` / `--prefix` named). */
  prefix: string;
  /** `<prefix>/hub`: the versioned bundle folders. */
  hubDir: string;
  /** The `azito-hub.cjs` the update process is started from. Unix: the one `current` points at. Windows: the running bundle's own (there is no `current`; the pointer is `current.txt`). */
  bundlePath: string;
}

/**
 * Resolve at the boundary: `bundleRoot` is `<prefix>/hub/<version>` or `<prefix>/hub/current`, so the prefix is found with
 * `resolveInstallPrefix` and a `-Prefix` other than the default is followed. (The data directory is not a place to start from:
 * `AZITO_DATA_DIR` can be anywhere.) A bundle that is not inside a `hub` folder is not a release install and cannot be updated.
 * Unix: for an install made by install.sh this is the place the update flow has always used (`current` and its target are
 * the same folder).
 */
export function resolveHubInstallPaths(host: Pick<HubInstallHost, 'platform' | 'bundleRoot'>): HubInstallPaths {
  if (host.bundleRoot === null) throw new Error('This hub is not a release install (a source checkout), so it has no hub folder to update');
  const prefix = resolveInstallPrefix(host.bundleRoot);
  if (prefix === null) throw new Error(`The bundle ${host.bundleRoot} is not inside <prefix>${path.sep}hub${path.sep}<version>, so the install prefix cannot be told`);
  const hubDir = path.join(prefix, 'hub');
  const bundlePath = host.platform === 'win32'
    ? path.join(host.bundleRoot, 'azito-hub.cjs')
    : path.join(hubDir, 'current', 'azito-hub.cjs');
  return { prefix, hubDir, bundlePath };
}
