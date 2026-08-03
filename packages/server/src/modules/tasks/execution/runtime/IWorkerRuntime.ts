import type { ServerConfig } from '../../../servers/Server';
import type { WorkerExecutionMode } from '../../../units/Unit';
import type { IPaneStream } from '../../../tmux/PaneStream';
import type { AgentTurn } from '../../turns/AgentTurn';
import type { PhaseSignalCapability } from '../../../prompt/executionEnvelope';

export interface WorkerLaunchContext {
  server: ServerConfig;
  target: string;
  supervisorTarget: string;
  taskId: number;
  unitId: number;
  windowType: string;
  workerExecutionMode: WorkerExecutionMode;
  effectiveLaunchCommand: string;
}

export interface WorkerContext {
  server: ServerConfig;
  target: string;
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
  target: string;
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
  /** Returns the actual command sent to the pane (may include supervisor wrap). */
  launch(ctx: WorkerLaunchContext): Promise<string>;
  sendPrompt(ctx: WorkerContext, prompt: string): Promise<void>;
  buildEnvelope(ctx: EnvelopeBuildContext): EnvelopeBuildResult;
  buildFollowUpEnvelope(ctx: FollowUpEnvelopeBuildContext): EnvelopeBuildResult;
  /** Returns the actual command sent to the pane (may include supervisor wrap). */
  resume(ctx: WorkerLaunchContext): Promise<string>;
}
