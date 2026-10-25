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
 *  - file content search: `GET /files/search` runs `rg` when the host has it, else the host's own search
 *    (`IFileOps.searchContent`, Node), and reports hit paths relative to the root with `/`.
 *  - the harness (`harness/install`, the status row, the auto-update): `setup.mjs` through the agent's IFileOps / `run` (setup.sh stays the Unix route).
 *  - git (diff / commits / branches / worktree list / repository discovery): `runGit`, which asks the host for the `git.exe` of Git for
 *    Windows (`GitLocator`: PATH, then the standard install locations). Not installed there: the API answers `501 git_not_found` with
 *    the reason, which is not known in advance, so it is shown as the error of the call, not as a closed feature.
 *
 * Closed on Windows: see `WIN32_UNAVAILABLE`.
 */

export type HostPlatform = 'linux' | 'darwin' | 'win32';

export interface HostPlatformInfo {
  platform: HostPlatform;
}

export type HostFeature =
  | 'taskExecution'
  | 'workerLaunch'
  | 'tmux'
  | 'browserRuntime';

export const HOST_FEATURES: readonly HostFeature[] = ['taskExecution', 'workerLaunch', 'tmux', 'browserRuntime'];

export type HostFeatureSupport =
  | { available: true }
  | { available: false; /** The tracking issue that brings the feature to this OS; null when it never will (tmux on Windows). */ issue: number | null };

/**
 * The Windows rows: feature -> the issue that supports it (null: never, the host has no such program). Each row says
 * which path closes it.
 *  - taskExecution (#371): `ExecuteTaskUseCase` starts the worker in a pane with a command (`paneShell.commandArgs` is null on Windows -> `unsupported_os`).
 *  - workerLaunch (#371): a new window with claude / codex / a command: the same pane command (`MisaoServers`, `paneShell.ts`).
 *  - tmux: not installed on Windows; `install-tmux` / `apply-tmux-config` answer `unsupported_os`.
 *  - browserRuntime (#372): `install-browser-runtime` is sh (`assertPosixHost`).
 */
const WIN32_UNAVAILABLE: Record<HostFeature, number | null> = {
  taskExecution: 371,
  workerLaunch: 371,
  tmux: null,
  browserRuntime: 372,
};

export function hostFeatureSupport(profile: HostPlatformInfo | null | undefined, feature: HostFeature): HostFeatureSupport {
  if (profile?.platform !== 'win32') return { available: true };
  return { available: false, issue: WIN32_UNAVAILABLE[feature] };
}
