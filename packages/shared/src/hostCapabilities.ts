/**
 * Which features a server's host supports, decided in one place from its OS (`hostProfile.platform`).
 *
 * Features are operations, closed one by one on the code path they take today, not by area. An operation that is
 * platform-neutral stays open on Windows even when its area (files, git) is not fully verified on a real host; the
 * table below says, for each closed one, which path closes it. A host whose OS is not recorded (null: an agent
 * registered before it was kept) is a Unix one: every feature is available.
 *
 * Open on Windows (not listed as features, with the path that lets them work):
 *  - file list / read / write / create / delete / rename: `IFileOps` (`FileBrowseService`), Windows paths handled by `pathApiFor`.
 *  - file name search: `searchFileNames` over `IFileOps.walk`.
 *
 * Closed on Windows until #370: git (see `WIN32_UNAVAILABLE`).
 */

export type HostPlatform = 'linux' | 'darwin' | 'win32';

export interface HostPlatformInfo {
  platform: HostPlatform;
}

export type HostFeature =
  | 'fileSearch'
  | 'git'
  | 'taskExecution'
  | 'workerLaunch'
  | 'tmux'
  | 'browserRuntime'
  | 'harness';

export const HOST_FEATURES: readonly HostFeature[] = ['fileSearch', 'git', 'taskExecution', 'workerLaunch', 'tmux', 'browserRuntime', 'harness'];

export type HostFeatureSupport =
  | { available: true }
  | { available: false; /** The tracking issue that brings the feature to this OS; null when it never will (tmux on Windows). */ issue: number | null };

/**
 * The Windows rows: feature -> the issue that supports it (null: never, the host has no such program). Each row says
 * which path closes it.
 *  - fileSearch (#370): `GET /files/search` runs `rg`, else `grep`, through `transport.run`, and reads the hits with `/`-rooted
 *    paths (`FileSearchService.parseHits`); Windows has no grep and returns backslash paths, so a search without rg finds nothing.
 *  - git (#370): diff / commits / worktree list / branch search (`modules/git/routes.ts`, `GET /branches`). The read paths take
 *    Windows paths now (`assertGitPathArg`); the row stays closed until worktree create / remove (R4) work on Windows and a host
 *    cannot be assumed to have `git`. Those routes answer `unsupported_os` (`assertGitSupported` in `shared/os/hostProfile.ts`). #370 makes git work on Windows, then removes this row and that guard.
 *  - taskExecution (#371): `ExecuteTaskUseCase` starts the worker in a pane with a command (`paneShell.commandArgs` is null on Windows -> `unsupported_os`).
 *  - workerLaunch (#371): a new window with claude / codex / a command: the same pane command (`MisaoServers`, `paneShell.ts`).
 *  - tmux: not installed on Windows; `install-tmux` / `apply-tmux-config` answer `unsupported_os`.
 *  - browserRuntime (#372): `install-browser-runtime` is sh (`assertPosixHost`).
 *  - harness (#371): `harness/install` is `setup.sh` (`assertPosixHost`).
 */
const WIN32_UNAVAILABLE: Record<HostFeature, number | null> = {
  fileSearch: 370,
  git: 370,
  taskExecution: 371,
  workerLaunch: 371,
  tmux: null,
  browserRuntime: 372,
  harness: 371,
};

export function hostFeatureSupport(profile: HostPlatformInfo | null | undefined, feature: HostFeature): HostFeatureSupport {
  if (profile?.platform !== 'win32') return { available: true };
  return { available: false, issue: WIN32_UNAVAILABLE[feature] };
}
