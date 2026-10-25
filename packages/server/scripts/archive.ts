import { execFileSync } from 'child_process';
import { hostTarOf } from '../src/shared/os/hostTar';

/** The `tar` the build scripts run: see `hostTarOf` (Windows: System32's bsdtar by absolute path; elsewhere `tar` on PATH). */
export function hostTar(): string {
  return hostTarOf({ platform: process.platform, systemRoot: process.env.SystemRoot });
}

/** Entry names of a `.tar.gz` or `.zip` (bsdtar reads both; GNU tar needs `-z` for the gzip one). */
export function listArchive(archive: string): string[] {
  const flags = archive.endsWith('.tar.gz') ? '-tzf' : '-tf';
  return execFileSync(hostTar(), [flags, archive], { maxBuffer: 256 * 1024 * 1024, timeout: 120000 })
    .toString()
    .split(/\r?\n/)
    .filter((line) => line !== '');
}
