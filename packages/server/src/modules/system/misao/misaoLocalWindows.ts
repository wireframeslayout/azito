import { createHash } from 'crypto';
import path from 'path';
import type { CommandSpec } from '../../../shared/exec/commandSpec';
import { runCommandSpec, runHostOf } from '../../../shared/exec/runCommandSpec';
import { LocalFileOps, localFileOpsHost } from '../../../shared/fs/LocalFileOps';
import type { HostEnv } from '../../../shared/os/hostEnv';
import { rawRunnerOf, SchtasksClient } from '../../../shared/os/taskScheduler/schtasks';
import { readMisaoSocketStatus, stageMisaoReleaseFile, type AgentMisaoHost } from '../../servers/transport/agentMisaoSocket';
import { MisaoWindowsInstaller, type WindowsTarget } from './MisaoWindowsInstaller';
import { MISAO_SERVICE, type MisaoPaths } from './misaoPaths';

/**
 * The hub's own misao on Windows: the very installer an agent server gets (`MisaoWindowsInstaller`), pointed at this machine.
 * The only difference is the target: an agent's is reached over HTTP, this one runs the same operations in-process (commands,
 * files, the pipe probe and the staging of the release files), so there is one definition of the task, the layout and the
 * switch / rollback steps. One misao per user: the task name, the `current` file and the pipe name are the agent's.
 */
export interface LocalMisaoWindows {
  installer: MisaoWindowsInstaller;
  target: WindowsTarget;
  /** The Task Scheduler as the hub's service managers use it, for reading the task (exists / running). */
  tasks: SchtasksClient;
  taskName: string;
}

export type LocalWindowsHostEnv = Pick<HostEnv, 'platform' | 'arch' | 'homeDir' | 'tmpDir' | 'execPath' | 'systemRoot'>;

/** What this host looks like to the installer: the same record an agent reports of itself. */
function localAgentHost(hostEnv: LocalWindowsHostEnv, paths: MisaoPaths, userName: string, env: NodeJS.ProcessEnv): AgentMisaoHost {
  if (hostEnv.systemRoot === undefined || hostEnv.systemRoot === '') {
    throw new Error('%SystemRoot% is not set, so conhost.exe, cmd.exe and schtasks.exe cannot be located');
  }
  return {
    homeDir: hostEnv.homeDir,
    nodePath: hostEnv.execPath,
    servicePath: env.PATH ?? '',
    platform: hostEnv.platform,
    arch: hostEnv.arch,
    windows: { systemRoot: hostEnv.systemRoot, userName, misaoRoot: paths.root },
  };
}

export function createLocalMisaoWindows(hostEnv: LocalWindowsHostEnv, paths: MisaoPaths, userName: string, env: NodeJS.ProcessEnv): LocalMisaoWindows {
  const host = localAgentHost(hostEnv, paths, userName, env);
  const runHost = runHostOf(hostEnv);
  const files = new LocalFileOps(localFileOpsHost(hostEnv));
  const target: WindowsTarget = {
    run: (spec: CommandSpec) => runCommandSpec(spec, runHost),
    files: () => files,
    fetchMisaoStatus: () => readMisaoSocketStatus({ path: paths.socket }, host),
    uploadMisaoFile: async (version, name, data) => {
      stageMisaoReleaseFile(host, version, name, data);
      return { name, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    },
  };
  return {
    installer: new MisaoWindowsInstaller({ taskName: MISAO_SERVICE.windowsTaskName }),
    target,
    tasks: new SchtasksClient(rawRunnerOf((command) => runCommandSpec(command, { ...runHost, rawOutput: true })), hostEnv),
    taskName: MISAO_SERVICE.windowsTaskName,
  };
}

/** Whether the misao task is registered, for a hub that has not built its misao service yet (the first-start choice of the local server's runtime). */
export async function misaoWindowsTaskExists(hostEnv: Pick<HostEnv, 'platform' | 'systemRoot'>): Promise<boolean> {
  const tasks = new SchtasksClient(rawRunnerOf((command) => runCommandSpec(command, { ...runHostOf(hostEnv), rawOutput: true })), hostEnv);
  return (await tasks.query(MISAO_SERVICE.windowsTaskName)).exists;
}

/** Whether a task definition runs something under `root` (XML entities decoded; paths compare without regard to case, like the file system). */
export function taskXmlNamesRoot(xml: string, root: string): boolean {
  const decoded = xml.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return decoded.toLowerCase().includes(`${path.win32.normalize(root).toLowerCase()}\\`);
}
