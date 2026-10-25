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
 *  - starting claude / codex / a command in a window (#371): a Windows host's worker is started by misao's `pane.open` with the program and its
 *    arguments (no shell line is typed): the agent is the first pane of the window it is created with (`PaneProgram` -> `openWorkspace` / `openWindow` `program`, `agents/workerProgram.ts`).
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
  | 'tmux'
  | 'browserRuntime'
  | 'harness';

export const HOST_FEATURES: readonly HostFeature[] = ['taskExecution', 'tmux', 'browserRuntime', 'harness'];

export type HostFeatureSupport =
  | { available: true }
  | { available: false; /** The tracking issue that brings the feature to this OS; null when it never will (tmux on Windows). */ issue: number | null };

/**
 * The Windows rows: feature -> the issue that supports it (null: never, the host has no such program). Each row says
 * which path closes it.
 *  - taskExecution (#371): `ExecuteTaskUseCase` refuses first. What stays closed behind it is the harness and hooks (T5) and the task's signal, azitoctl and push scripts (T6).
 *  - tmux: not installed on Windows; `install-tmux` / `apply-tmux-config` answer `unsupported_os`.
 *  - browserRuntime (#372): `install-browser-runtime` is sh (`assertPosixHost`).
 *  - harness (#371): `harness/install` is `setup.sh` (`assertPosixHost`).
 */
const WIN32_UNAVAILABLE: Record<HostFeature, number | null> = {
  taskExecution: 371,
  tmux: null,
  browserRuntime: 372,
  harness: 371,
};

export function hostFeatureSupport(profile: HostPlatformInfo | null | undefined, feature: HostFeature): HostFeatureSupport {
  if (profile?.platform !== 'win32') return { available: true };
  return { available: false, issue: WIN32_UNAVAILABLE[feature] };
}
