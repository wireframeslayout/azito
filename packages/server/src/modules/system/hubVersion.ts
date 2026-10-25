/**
 * The two shapes of a hub version, and why they differ.
 *
 * - {@link HUB_POINTER_VERSION_PATTERN}: what `hub\current.txt` may hold on Windows. The same rule is written out in install.ps1
 *   (`Test-ReleaseVersion`), in azito.cmd (a `findstr` expression) and in the launcher script of the Task Scheduler task, which
 *   cannot import this. It is the widest of the three, since a pointer is only ever read back and becomes a folder name.
 * - {@link RELEASE_TAG_PATTERN}: which GitHub release tags an update accepts (`vN.N.N` with an optional `-suffix`). Narrower on
 *   purpose: it validates input from the network before the tag reaches a path or a command line. Every tag it accepts is also a
 *   valid pointer (a test checks that), so an update can always write the pointer for the tag it installs.
 *
 * `semver.ts` has a third copy of the release-tag shape, with capture groups to compare versions; it stays there, the capture
 * groups being its job.
 */
export const HUB_POINTER_VERSION_PATTERN = '^v?[0-9]+\\.[0-9]+\\.[0-9]+([-+.][0-9A-Za-z.-]+)?$';

export const RELEASE_TAG_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

const POINTER_VERSION_RE = new RegExp(HUB_POINTER_VERSION_PATTERN);

export function isHubPointerVersion(value: string): boolean {
  return POINTER_VERSION_RE.test(value);
}

export function isReleaseTag(value: string): boolean {
  return RELEASE_TAG_PATTERN.test(value);
}
