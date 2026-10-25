import type { MuxDriverKind, PaneHandle } from '@azito/shared';
import type { IMuxClient } from '../../../tmux/IMuxClient';
import type { ServerConfig } from '../../../servers/Server';
import type { WorkerExecutionMode } from '../../../units/Unit';
import type { IPaneStream } from '../../../tmux/PaneStream';
import type { AgentTurn } from '../../turns/AgentTurn';
import type { PhaseSignalCapability } from '../../../prompt/executionEnvelope';
import type { TaskTempServer } from '../../../../shared/os/taskTempFiles';
import type { ShellDialect } from '../../../../shared/os/shellDialect';
import type { IFileOps } from '../../../../shared/fs/fileOps';
import type { WorkerLaunch } from '../../../agents/WorkerLaunch';

export interface WorkerLaunchContext {
  server: ServerConfig;
  handle: PaneHandle;
  driver: IMuxClient;
  supervisorTarget: string;
  taskId: number;
  unitId: number;
  windowId?: number;
  /** The mux kind of the launched window (its `MuxRef.kind`); decides whether it runs under a supervisor. */
  windowKind: MuxDriverKind;
  windowType: string;
  workerExecutionMode: WorkerExecutionMode;
  /** What to start: the worker with its session arguments. */
  launch: WorkerLaunch;
  /** The shell of the launched pane (the target host's): the launch line and the supervisor wrapper are written in it. */
  dialect: ShellDialect;
  /** The host starts the worker as a program in place of the pane's shell (Windows), rather than by a line typed into it. */
  startsAsProgram: boolean;
  /** Where the worker starts when it is started as a program (a typed line is preceded by the caller's own directory change). */
  cwd: string | null;
  /** The env the pane was created with, given again to the pane that replaces it; null when this call does not have it. */
  paneEnv: Readonly<Record<string, string>> | null;
  /** The target host's file operations (expands a `~` working directory when the worker is started as a program). */
  files: () => IFileOps;
}

/** The result of starting a worker: the line or command it was started with (for the log), and the pane it runs in (a different pane when it replaced the shell's). */
export interface WorkerLaunchResult {
  command: string;
  handle: PaneHandle;
}

export interface WorkerContext {
  server: ServerConfig;
  handle: PaneHandle;
  driver: IMuxClient;
  supervisorTarget: string;
  taskId: number;
  unitId: number;
}

export interface EnvelopeBuildContext {
  phase: string;
  capability: PhaseSignalCapability;
  nonce: string;
  taskId: number;
  unitId: number;
  workerExecutionMode: WorkerExecutionMode;
  server: ServerConfig;
  /** Where this server keeps the task's files, resolved once by the caller (see `TransportFactory.taskTempServer`). */
  tempServer: TaskTempServer;
  handle: PaneHandle;
  supervisorTarget: string;
  prompt: string;
  outputFilePath: string;
  doneMarker: string;
  questionsMarker: string;
  testFailedMarker: string;
}

export interface EnvelopeBuildResult {
  markerizedPrompt: string;
  signalStream: IPaneStream;
  httpSignalTurn: AgentTurn | null;
}

export type FollowUpEnvelopeBuildContext = Omit<EnvelopeBuildContext, 'phase' | 'capability'>;

export interface IWorkerRuntime {
  /** Returns the actual command sent to the pane (may include supervisor wrap) and the pane the worker runs in. */
  launch(ctx: WorkerLaunchContext): Promise<WorkerLaunchResult>;
  sendPrompt(ctx: WorkerContext, prompt: string): Promise<void>;
  buildEnvelope(ctx: EnvelopeBuildContext): EnvelopeBuildResult;
  buildFollowUpEnvelope(ctx: FollowUpEnvelopeBuildContext): EnvelopeBuildResult;
  /** Returns the actual command sent to the pane (may include supervisor wrap) and the pane the worker runs in. */
  resume(ctx: WorkerLaunchContext): Promise<WorkerLaunchResult>;
}
