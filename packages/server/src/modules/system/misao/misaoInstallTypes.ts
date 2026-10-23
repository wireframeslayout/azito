import type { AgentTransport } from '../../servers/transport/AgentTransport';

/** What the installer needs of an agent: its shell, what it sees on disk, and a place to put release files. */
export type MisaoInstallTarget = Pick<AgentTransport, 'exec' | 'run' | 'files' | 'fetchMisaoStatus' | 'uploadMisaoFile' | 'hostProfile'>;

/** `taskscheduler`: a Windows agent's logon task. */
export type MisaoAgentStartMethod = 'systemd' | 'nohup' | 'taskscheduler' | 'running';

/** What the installer is doing, in order. A code (not a sentence) so each reader can say it in its own language. `stop` is only part of an update. */
export type MisaoInstallStep = 'inspect' | 'transfer' | 'prepare' | 'stop' | 'start';

export interface MisaoAgentInstallResult {
  /** The release this install put on the host (the bundled one). */
  version: string;
  /** The release the daemon runs: the one that was already running, when it is not the bundled one. */
  runningVersion: string;
  startMethod: MisaoAgentStartMethod;
  /** A daemon of an older release was running and is left alone: switching it closes every pane (an explicit update). */
  updateAvailable: boolean;
}
