/** The Task Scheduler task name of the agent (letters, digits, `.`, `_`, `-`). The one place the default is written. */
export const AGENT_WINDOWS_TASK_NAME = 'AzitoAgent';
/** The agent's folder, relative to the user's home. */
export const AGENT_WINDOWS_DIR = '.azito\\agent';
export const AGENT_WINDOWS_PORT = 3002;
/** The Task Scheduler task name of the misao daemon on a Windows agent (also the hub's own: `MISAO_SERVICE`). */
export const MISAO_WINDOWS_TASK_NAME = 'AzitoMisao';
/** The misao folder of a Windows agent, relative to the user's home. */
export const MISAO_WINDOWS_DIR = '.azito\\misao';

/**
 * What differs between the real Windows agent and one a person tries out beside it (a `w806-` task, folder and port): the
 * Task Scheduler task name, the folder under the user's home and the listening port. Resolved once at the entry point.
 */
export interface WindowsAgentOptions {
  taskName: string;
  /** Under `%USERPROFILE%`, with `\` separators. */
  dir: string;
  port: number;
  /** The Task Scheduler task name of the misao daemon the hub installs beside the agent. */
  misaoTaskName: string;
  /** The misao folder under `%USERPROFILE%`, with `\` separators. The agent is told (its settings file) when it is not the default. */
  misaoDir: string;
}

export const DEFAULT_WINDOWS_AGENT_OPTIONS: WindowsAgentOptions = { taskName: AGENT_WINDOWS_TASK_NAME, dir: AGENT_WINDOWS_DIR, port: AGENT_WINDOWS_PORT, misaoTaskName: MISAO_WINDOWS_TASK_NAME, misaoDir: MISAO_WINDOWS_DIR };

const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** One folder name: nothing that needs quoting in a task XML or a PowerShell literal, and no `%NAME%` reference. */
const DIR_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * A folder under the user's home as `\`-separated segments (`/` is accepted). Shared by the hub's settings and the agent's own
 * (`AZITO_MISAO_DIR`), so both read the same text the same way. `name` is the setting, for the message.
 */
export function parseHomeRelativeDir(raw: string, name: string): string {
  const segments = raw.split(/[\\/]/);
  if (segments.some((s) => !DIR_SEGMENT.test(s) || s === '.' || s === '..')) {
    throw new Error(`${name} must be a folder under the home directory made of letters, digits, ".", "_" and "-" (got "${raw}")`);
  }
  return segments.join('\\');
}

/**
 * Reads the overrides: `AZITO_WIN_AGENT_TASK_NAME`, `AZITO_WIN_AGENT_DIR` (relative to the home, `\` or `/` separators),
 * `AZITO_WIN_AGENT_PORT`, and the misao beside the agent: `AZITO_WIN_MISAO_TASK_NAME` and `AZITO_WIN_MISAO_DIR`. An unset (or
 * empty) one keeps its default; a bad value throws, it is never replaced.
 */
export function resolveWindowsAgentOptions(env: NodeJS.ProcessEnv): WindowsAgentOptions {
  const taskName = env.AZITO_WIN_AGENT_TASK_NAME || DEFAULT_WINDOWS_AGENT_OPTIONS.taskName;
  if (!TASK_NAME.test(taskName)) throw new Error(`AZITO_WIN_AGENT_TASK_NAME must be letters, digits, ".", "_" and "-" only (got "${taskName}")`);
  const misaoTaskName = env.AZITO_WIN_MISAO_TASK_NAME || DEFAULT_WINDOWS_AGENT_OPTIONS.misaoTaskName;
  if (!TASK_NAME.test(misaoTaskName)) throw new Error(`AZITO_WIN_MISAO_TASK_NAME must be letters, digits, ".", "_" and "-" only (got "${misaoTaskName}")`);

  const dir = parseHomeRelativeDir(env.AZITO_WIN_AGENT_DIR || DEFAULT_WINDOWS_AGENT_OPTIONS.dir, 'AZITO_WIN_AGENT_DIR');
  const misaoDir = parseHomeRelativeDir(env.AZITO_WIN_MISAO_DIR || DEFAULT_WINDOWS_AGENT_OPTIONS.misaoDir, 'AZITO_WIN_MISAO_DIR');

  const rawPort = env.AZITO_WIN_AGENT_PORT;
  const port = rawPort ? Number(rawPort) : DEFAULT_WINDOWS_AGENT_OPTIONS.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`AZITO_WIN_AGENT_PORT must be a whole number from 1024 to 65535 (got "${rawPort}")`);

  return { taskName, dir, port, misaoTaskName, misaoDir };
}
