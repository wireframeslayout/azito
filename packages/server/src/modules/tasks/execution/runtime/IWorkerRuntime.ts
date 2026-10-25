import type { MuxDriverKind, PaneHandle } from '@azito/shared';
import type { IMuxClient } from '../../../tmux/IMuxClient';
import type { ServerConfig } from '../../../servers/Server';
import type { WorkerExecutionMode } from '../../../units/Unit';
import type { IPaneStream } from '../../../tmux/PaneStream';
import type { AgentTurn } from '../../turns/AgentTurn';
import type { EnvelopeHost, PhaseSignalCapability } from '../../../prompt/executionEnvelope';
import type { TaskTempServer } from '../../../../shared/os/taskTempFiles';
import type { ShellDialect } from '../../../../shared/os/shellDialect';

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
  effectiveLaunchCommand: string;
  /** The shell of the launched pane (the target host's), for the supervisor wrapper. */
  dialect: ShellDialect;
  /**
   * The worker is already the pane's program (a Windows host creates the window with it, #371): nothing is typed and no supervisor wraps
   * it. `effectiveLaunchCommand` only names it.
   */
  startedAsProgram: boolean;
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
  /** The shell and azitoctl the prompt is written for: decided by the server's OS, resolved once by the caller (`resolveEnvelopeHost`). */
  host: EnvelopeHost;
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
  /** Returns the actual command sent to the pane (may include supervisor wrap); for a worker started as a program, the launch line it was started with. */
  launch(ctx: WorkerLaunchContext): Promise<string>;
  sendPrompt(ctx: WorkerContext, prompt: string): Promise<void>;
  buildEnvelope(ctx: EnvelopeBuildContext): EnvelopeBuildResult;
  buildFollowUpEnvelope(ctx: FollowUpEnvelopeBuildContext): EnvelopeBuildResult;
  /** Returns the actual command sent to the pane (may include supervisor wrap). */
  resume(ctx: WorkerLaunchContext): Promise<string>;
}
