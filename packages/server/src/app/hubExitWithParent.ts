import type { HostEnv } from '../shared/os/hostEnv';
import { processExists, readWindowsProcessCreation, startParentWatch, type ParentWatch } from '../agent/parentWatch';

/** The name of the setting `run.ps1 -Service` gives the hub: the process id of the `conhost.exe` the Task Scheduler task runs under. */
export const EXIT_WITH_PID_ENV = 'AZITO_HUB_EXIT_WITH_PID';

const WATCH_INTERVAL_MS = 3000;
const VERIFY_INTERVAL_MS = 30_000;

/**
 * The process the hub must follow, or undefined when it was not started by the Task Scheduler task (a hub started by hand, or on
 * another OS, has no such setting). A value that is not a process id is an error, never "not set".
 */
export function parseExitWithPid(env: NodeJS.ProcessEnv): number | undefined {
  const value = env[EXIT_WITH_PID_ENV];
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`${EXIT_WITH_PID_ENV} must be a process id, got "${value}"`);
  return Number(value);
}

/**
 * Reads the setting once at the entry point and removes it from the environment, so that the hub's children (panes, workers, the
 * browser, a hub started from a pane with `azito run`) do not inherit it and take themselves for a task-launched hub.
 */
export function takeExitWithPid(env: NodeJS.ProcessEnv): number | undefined {
  const pid = parseExitWithPid(env);
  delete env[EXIT_WITH_PID_ENV];
  return pid;
}

export interface HubParentWatchDeps {
  hostEnv: Pick<HostEnv, 'platform' | 'systemRoot'>;
  /** The process to follow (from {@link takeExitWithPid}), or undefined when the hub was not started by the task. */
  pid: number | undefined;
  /** Called once when the followed process is gone. */
  onGone: (reason: string) => void;
  warn: (message: string) => void;
  info: (message: string) => void;
}

/**
 * The hub of a Windows install runs as a Task Scheduler task under `conhost.exe --headless` (see `windowsHubService`), and the
 * Task Scheduler's "End" (`azito stop`) ends only that `conhost.exe`: the hub would be left running. `run.ps1 -Service` names the
 * conhost's process id, and the hub follows it the way the Windows agent follows its parent (`startParentWatch`: a signal-0
 * probe, plus the creation time so that a process id handed to another process is noticed).
 * Returns undefined when nothing is to be followed.
 */
export function startHubExitWithParent(deps: HubParentWatchDeps): ParentWatch | undefined {
  const pid = deps.pid;
  if (pid === undefined) return undefined;
  if (deps.hostEnv.platform !== 'win32') throw new Error(`${EXIT_WITH_PID_ENV} is only for the Windows service launch`);
  const systemRoot = deps.hostEnv.systemRoot;
  return startParentWatch({
    pid,
    aliveIntervalMs: WATCH_INTERVAL_MS,
    verifyIntervalMs: VERIFY_INTERVAL_MS,
    isAlive: processExists,
    readCreation: (target) => (systemRoot ? readWindowsProcessCreation(systemRoot, target) : Promise.resolve(null)),
    onGone: deps.onGone,
    onUnverifiable: deps.warn,
    onVerifiable: deps.info,
  });
}
