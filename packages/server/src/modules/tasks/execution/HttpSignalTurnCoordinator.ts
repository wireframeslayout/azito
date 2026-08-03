import type { SqliteAgentTurnRepository } from '../turns/SqliteAgentTurnRepository';
import type { TurnSignalHub } from '../turns/TurnSignalHub';
import { InProcessSignalStream } from '../turns/InProcessSignalStream';
import { buildTurnToken, type AgentTurn, type AgentTurnStatus } from '../turns/AgentTurn';
import { renderForHttpSignal } from '../../prompt/PhasePromptRenderer';
import { resolveAzitoctlPath } from './AzitoctlPath';
import type { ServerConfig } from '../../servers/Server';
import type { PhaseSignalCapability } from '../../prompt/executionEnvelope';
import type { IPaneStream } from '../../tmux/PaneStream';
import type { PaneClassification, PaneQuestion } from '../../llm/PaneClassifier';

export interface StartHttpSignalTurnOpts {
  taskId: number;
  unitId: number;
  kind: 'phase' | 'follow_up';
  /** null only for kind: 'follow_up', which has no phase of its own. */
  phase: string | null;
  capability: PhaseSignalCapability;
  nonce: string;
  server: ServerConfig;
  target: string;
  /** The already-expanded Sidekick body (or follow-up comment) to wrap with the http-signal envelope. */
  prompt: string;
  outputFilePath: string;
}

export interface HttpSignalTurnHandle {
  turn: AgentTurn;
  signalStream: IPaneStream;
  /** `prompt` with the http-signal completion_signal block appended. */
  markerizedPrompt: string;
}

/**
 * Shared http-signal execution-mode logic used by both PhaseLoopRunner
 * (phase turns) and ExecuteTaskUseCase.followUp (follow_up turns): creates
 * the AgentTurn row, wires an InProcessSignalStream to it, renders the
 * httpSignalEnvelope, and reconciles turn state once WorkerWaiter's wait
 * settles (Issue: AZITO監視強化 Phase 1). Kept as a standalone collaborator
 * (rather than living inside PhaseLoopRunner) specifically so followUp can
 * reuse it without PhaseLoopRunner having to expose phase-loop internals.
 */
export class HttpSignalTurnCoordinator {
  constructor(
    private turnRepo: SqliteAgentTurnRepository,
    private turnSignalHub: TurnSignalHub,
  ) {}

  /**
   * Creates the turn and starts its signal stream BEFORE rendering the
   * prompt that will be sent to the worker — callers must send the returned
   * `markerizedPrompt` only after this returns, so the stream is already
   * subscribed (and any signal that still arrives before `waitForWorker`
   * attaches its own listener is buffered by InProcessSignalStream, not
   * lost).
   */
  start(opts: StartHttpSignalTurnOpts): HttpSignalTurnHandle {
    this.turnRepo.supersedeRunning(opts.taskId);
    const turn = this.turnRepo.create({
      taskId: opts.taskId,
      unitId: opts.unitId,
      kind: opts.kind,
      phase: opts.phase,
      nonce: opts.nonce,
      serverName: opts.server.name,
      tmuxTarget: opts.target,
      outputFilePath: opts.outputFilePath,
    });
    const signalStream = new InProcessSignalStream(this.turnSignalHub, turn.id);
    signalStream.start();
    const markerizedPrompt = renderForHttpSignal(opts.prompt, {
      phase: opts.phase,
      capability: opts.capability,
      turnToken: buildTurnToken(turn),
      azitoctlPath: resolveAzitoctlPath(opts.server),
      outputFilePath: opts.outputFilePath,
    });
    return { turn, signalStream, markerizedPrompt };
  }

  /**
   * Reconciles the turn's terminal state against how WorkerWaiter's wait
   * settled, and returns the classification the caller should actually act
   * on. AgentTurn.status — set by AgentSignalService when azitoctl reports —
   * is authoritative whenever it is no longer 'running': this overrides
   * `classification` (which InProcessSignalStream can only approximate,
   * e.g. it emits the same 'phase_complete' marker for both a normal
   * completion and a hard `azitoctl fail` to unblock the wait). When the
   * turn is still 'running', the wait settled via a fallback path (idle
   * classifier / completion probe / timeout) with no explicit signal ever
   * received, so this marks the turn ended itself — inferred, with
   * 'classifier' as the most conservative completionSource available
   * (WorkerWaiter's WaitResult carries no finer-grained source).
   */
  async finalize(
    turnId: number,
    classification: PaneClassification,
    aborted: boolean,
  ): Promise<{ classification: PaneClassification; turn: AgentTurn | null }> {
    const current = this.turnRepo.findById(turnId);
    if (!current) return { classification, turn: null };

    switch (current.status) {
      case 'failed':
        return { classification: { status: 'stopped' }, turn: current };
      case 'test_failed':
      case 'completed':
        return { classification: { status: 'phase_complete' }, turn: current };
      case 'questions':
        return { classification: this.questionClassification(turnId, classification), turn: current };
      case 'aborted':
      case 'superseded':
        return { classification, turn: current };
      case 'running':
        return this.finalizeStillRunning(turnId, classification, aborted);
    }
  }

  /**
   * Builds the question classification for a turn explicitly reported as
   * 'questions'. When the wait's own classification already carries the
   * parsed questions array (the normal path: InProcessSignalStream emitted
   * 'questions_json' and WorkerWaiter JSON.parse'd it), it is used as-is.
   * Otherwise (wait settled another way — e.g. timeout raced the signal —
   * or the marker's payload failed to parse), the questions are recovered
   * from the turn's `questions` event payload (same pattern as readOutput),
   * so PhaseLoopRunner's `classification.questions || []` never collapses a
   * real question set into an empty pendingQuestions array.
   */
  private questionClassification(turnId: number, classification: PaneClassification): PaneClassification {
    if (classification.status === 'question' && (classification.questions?.length ?? 0) > 0) {
      return classification;
    }
    const questions = this.readQuestions(turnId);
    return questions !== null ? { status: 'question', questions } : { status: 'question' };
  }

  /** Reads the questions array from the turn's `questions` event payload, when available. */
  private readQuestions(turnId: number): PaneQuestion[] | null {
    const event = this.turnRepo.findLatestEventByType(turnId, 'questions');
    if (!event?.payload) return null;
    try {
      const parsed = JSON.parse(event.payload) as { questions?: unknown };
      return Array.isArray(parsed.questions) ? (parsed.questions as PaneQuestion[]) : null;
    } catch {
      return null;
    }
  }

  private finalizeStillRunning(
    turnId: number,
    classification: PaneClassification,
    aborted: boolean,
  ): { classification: PaneClassification; turn: AgentTurn | null } {
    if (aborted) {
      this.turnRepo.markEnded(turnId, { status: 'aborted', completionSource: 'abort', confidence: 'inferred' });
      this.turnRepo.appendEvent(turnId, { type: 'aborted', source: 'internal' });
      return { classification, turn: this.turnRepo.findById(turnId) };
    }
    const inferredStatus: AgentTurnStatus = classification.status === 'phase_complete' ? 'completed'
      : classification.status === 'question' ? 'questions'
      : 'failed';
    this.turnRepo.markEnded(turnId, { status: inferredStatus, completionSource: 'classifier', confidence: 'inferred' });
    this.turnRepo.appendEvent(turnId, { type: inferredStatus, source: 'internal' });
    return { classification, turn: this.turnRepo.findById(turnId) };
  }

  /**
   * Re-marks a turn `failed` after the caller's fail-fast guard rejected an
   * inferred completion (a phase_complete that carried neither an explicit
   * azitoctl signal nor any phase output — see PhaseLoopRunner's http-signal
   * post-phase guard). Overwrites the `completed` state `finalize()` had
   * inferred from the classifier.
   */
  rejectInferredCompletion(turnId: number): void {
    this.turnRepo.markEnded(turnId, { status: 'failed', completionSource: 'classifier', confidence: 'inferred' });
    this.turnRepo.appendEvent(turnId, {
      type: 'failed',
      payload: JSON.stringify({ reason: 'phase_complete_without_output_rejected' }),
      source: 'internal',
    });
  }

  /** Reads the phase output from the turn's `complete` event payload, when available. */
  readOutput(turnId: number): string | null {
    const event = this.turnRepo.findLatestEventByType(turnId, 'complete');
    if (!event?.payload) return null;
    try {
      const parsed = JSON.parse(event.payload) as { output?: unknown };
      return typeof parsed.output === 'string' && parsed.output.length > 0 ? parsed.output : null;
    } catch {
      return null;
    }
  }
}
