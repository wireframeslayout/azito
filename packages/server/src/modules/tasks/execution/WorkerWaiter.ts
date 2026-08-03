import type { TmuxClient } from '../../tmux/TmuxClient';
import type { ServerConfig } from '../../servers/Server';
import type { PaneClassifier, PaneClassification } from '../../llm/PaneClassifier';
import type { IContentExtractor } from '../../llm/ContentExtractor';
import type { IPaneStream, IPaneStreamFactory } from '../../tmux/PaneStream';
import type { LogType } from '../ExecutionLog';
import type { WorkerInputService } from './WorkerInputService';
import { removeCompletionSignalBlock, extractPlanMarkdown } from './PromptExpander';

export type AppendLogFn = (taskId: number, unitId: number, type: LogType, content: unknown) => void;

export interface WaitResult {
  output: string;
  classification: PaneClassification;
}

/**
 * Seconds since last tmux window activity below which a worker pane is
 * considered actively running. Shared with AgentActivityMonitor
 * (modules/operations) so both use the same notion of "active".
 */
export const ACTIVITY_THRESHOLD_SEC = 30;

const CONFIRMATION_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/N\]/i,
  /\[Y\/n\]/i,
  /\(yes\/no\)/i,
  /Do you want to proceed/i,
  /Are you sure/i,
  /Press Enter to continue/i,
  /Continue\?/i,
  /Proceed\?/i,
  /\? \(Y\)es/i,
  /accept\?/i,
];

/**
 * Manages the pane/signal stream lifecycle around a worker invocation:
 * starting pipe-pane capture, waiting for completion/question/stop markers
 * (with idle/heartbeat/auto-confirm handling), and reading back the phase
 * output file and plan content the worker produced.
 */
export class WorkerWaiter {
  constructor(
    private tmux: TmuxClient,
    private paneClassifier: PaneClassifier,
    private contentExtractor: IContentExtractor,
    private paneStreamFactory: IPaneStreamFactory,
    private appendLog: AppendLogFn,
    private touchTask: (taskId: number) => void,
    private workerInput: WorkerInputService,
  ) {}

  startPaneStream(
    server: ServerConfig,
    target: string,
    taskId: number,
    unitId: number,
  ): IPaneStream | null {
    const paneId = `${taskId}-${Date.now()}`;
    const paneStream = this.paneStreamFactory.create(paneId, server);
    paneStream.start();
    this.tmux.startPipePane(server, target, paneStream.getFilePath()).catch((err) => {
      this.appendLog(taskId, unitId, 'command', { type: 'pipe_pane_error', message: (err as Error).message });
    });
    return paneStream;
  }

  startSignalStream(
    server: ServerConfig,
    taskId: number,
    doneMarker: string,
    questionsMarker: string,
  ): IPaneStream {
    const stream = this.paneStreamFactory.create(`${taskId}-sig`, server);
    stream.start();
    stream.setMarkers(doneMarker, questionsMarker);
    stream.enableMarkerDetection();
    return stream;
  }

  async readPhaseOutputFile(
    server: ServerConfig,
    outputFilePath: string,
  ): Promise<string | null> {
    try {
      const result = await this.tmux.execCommand(server, `cat ${outputFilePath} 2>/dev/null`);
      void this.tmux.execCommand(server, `rm -f ${outputFilePath}`).catch(() => {});
      const content = result.stdout.trim();
      return content.length > 0 ? content : null;
    } catch {
      return null;
    }
  }

  async capturePaneText(
    server: ServerConfig,
    target: string,
  ): Promise<string> {
    try {
      const result = await this.tmux.capturePane(server, target, -3000);
      return result.stdout;
    } catch {
      return '';
    }
  }

  async extractPlanWithFallback(
    server: ServerConfig,
    target: string,
    pipeOutput: string,
  ): Promise<string | null> {
    const rawPaneText = await this.capturePaneText(server, target);
    const paneText = rawPaneText ? removeCompletionSignalBlock(rawPaneText) : rawPaneText;
    const cleanedPipeOutput = removeCompletionSignalBlock(pipeOutput);
    if (paneText) {
      try {
        const { planMarkdown } = await this.contentExtractor.extractPlan(paneText);
        if (planMarkdown) return planMarkdown;
      } catch { /* fall through to programmatic */ }
    }
    return extractPlanMarkdown(paneText || cleanedPipeOutput);
  }

  async waitForWorker(
    server: ServerConfig,
    target: string,
    taskId: number,
    unitId: number,
    signal: AbortSignal,
    paneStream: IPaneStream,
    doneMarker?: string,
    signalStream?: IPaneStream,
    completionProbe?: () => Promise<boolean>,
    supervisorTarget?: string,
  ): Promise<WaitResult> {
    const MAX_IDLE = 300_000;
    const IDLE_TIMEOUT = 120_000;
    const HEARTBEAT_INTERVAL = 10_000;
    const MARKER_ENABLE_DELAY = 3_000;
    const MAX_PHASE_DURATION = 30 * 60_000;
    const MAX_PHASE_DURATION_EXTENDED = 60 * 60_000;
    const MAX_CONSECUTIVE_STILL_WORKING = 5;
    const QUIESCENCE_MS = 2_000;
    const QUIESCENCE_MAX_WAIT_MS = 45_000;

    this.appendLog(taskId, unitId, 'command', {
      type: 'wait_start_pipe',
      filePath: paneStream.getFilePath(),
      ...(signalStream ? { signalFilePath: signalStream.getFilePath() } : {}),
    });

    return new Promise<WaitResult>((resolve) => {
      let resolved = false;
      let lastDataTime = Date.now();
      let lastPaneDataTime = Date.now();
      let lastClassifyTime = 0;
      let consecutiveStillWorking = 0;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      let autoConfirmTimer: ReturnType<typeof setInterval> | null = null;
      let phaseMaxTimer: ReturnType<typeof setTimeout> | null = null;
      let quiescenceTimer: ReturnType<typeof setInterval> | null = null;

      const phaseStartTime = Date.now();

      let enableTimer: ReturnType<typeof setTimeout> | null = null;
      if (!signalStream) {
        enableTimer = setTimeout(() => {
          if (!resolved) {
            paneStream.enableMarkerDetection();
            this.appendLog(taskId, unitId, 'command', { type: 'pipe_markers_enabled', lineCount: paneStream.getBuffer().split('\n').length });
          }
        }, MARKER_ENABLE_DELAY);
      }

      const cleanup = () => {
        if (enableTimer) clearTimeout(enableTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (autoConfirmTimer) clearInterval(autoConfirmTimer);
        if (phaseMaxTimer) clearTimeout(phaseMaxTimer);
        if (quiescenceTimer) clearInterval(quiescenceTimer);
        try { this.tmux.stopPipePane(server, target).catch(() => {}); } catch {}
        paneStream.stop();
        if (signalStream) signalStream.stop();
      };

      const finish = (result: WaitResult) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(result);
      };

      // Before giving up as stopped, check the completion probe (e.g. push/PR
      // already exist on the remote) — the worker may have finished without
      // the signal being captured
      const finishStoppedOrVerified = () => {
        if (!completionProbe) {
          finish({ output: paneStream.getBuffer(), classification: { status: 'stopped' } });
          return;
        }
        completionProbe().then((verified) => {
          if (resolved) return;
          if (verified) {
            this.appendLog(taskId, unitId, 'command', { type: 'completion_probe_verified' });
            finish({ output: paneStream.getBuffer(), classification: { status: 'phase_complete' } });
          } else {
            finish({ output: paneStream.getBuffer(), classification: { status: 'stopped' } });
          }
        }).catch(() => {
          finish({ output: paneStream.getBuffer(), classification: { status: 'stopped' } });
        });
      };

      // Wait for pane output to quiesce before finishing (used when signalStream is present)
      const finishAfterQuiescence = (makeResult: () => WaitResult) => {
        if (resolved) return;
        // Avoid starting multiple quiescence waits
        if (quiescenceTimer !== null) return;
        const quiescenceStart = Date.now();
        this.appendLog(taskId, unitId, 'command', { type: 'quiescence_wait_start' });
        quiescenceTimer = setInterval(() => {
          if (resolved) {
            if (quiescenceTimer) clearInterval(quiescenceTimer);
            quiescenceTimer = null;
            return;
          }
          const now = Date.now();
          const paneIdle = now - lastPaneDataTime;
          const elapsed = now - quiescenceStart;
          if (paneIdle >= QUIESCENCE_MS || elapsed >= QUIESCENCE_MAX_WAIT_MS) {
            if (quiescenceTimer) clearInterval(quiescenceTimer);
            quiescenceTimer = null;
            this.appendLog(taskId, unitId, 'command', { type: 'quiescence_wait_done', paneIdle, elapsed });
            finish(makeResult());
          }
        }, 500);
      };

      const markerSource = signalStream ?? paneStream;
      markerSource.on('marker', (type: string, raw: string) => {
        if (type === 'phase_complete') {
          this.appendLog(taskId, unitId, 'command', { type: 'pipe_marker', marker: 'phase_complete' });
          if (signalStream) {
            finishAfterQuiescence(() => ({ output: paneStream.getBuffer(), classification: { status: 'phase_complete' } }));
          } else {
            finish({ output: paneStream.getBuffer(), classification: { status: 'phase_complete' } });
          }
        } else if (type === 'questions_json') {
          this.appendLog(taskId, unitId, 'command', { type: 'pipe_marker', marker: 'questions_json' });
          // Parse the questions from raw at marker-receive time (signal file is stable)
          let classification: PaneClassification;
          try {
            const questions = JSON.parse(raw);
            classification = { status: 'question', questions };
          } catch {
            classification = { status: 'question' };
          }
          if (signalStream) {
            finishAfterQuiescence(() => ({ output: paneStream.getBuffer(), classification }));
          } else {
            finish({ output: paneStream.getBuffer(), classification });
          }
        }
      });

      paneStream.on('data', () => {
        lastDataTime = Date.now();
        lastPaneDataTime = Date.now();
        consecutiveStillWorking = 0;
      });

      if (signalStream) {
        signalStream.on('data', () => {
          lastDataTime = Date.now();
        });
      }

      autoConfirmTimer = setInterval(async () => {
        if (resolved) return;
        const buf = paneStream.getBuffer();
        const lastLines = buf.split('\n').slice(-5).join('\n');
        const needsConfirmation = CONFIRMATION_PATTERNS.some((p) => p.test(lastLines));
        if (needsConfirmation) {
          this.appendLog(taskId, unitId, 'command', { type: 'auto_approve', detected: lastLines.trim().split('\n').pop() });
          try { await this.workerInput.sendKeys(server, target, ['y', 'Enter'], { taskId, unitId }, supervisorTarget); } catch {}
        }
      }, 3000);

      let phaseDeadline = phaseStartTime + MAX_PHASE_DURATION;

      heartbeatTimer = setInterval(async () => {
        if (resolved) return;
        try { this.touchTask(taskId); } catch {}

        const activity = await this.tmux.getWindowActivity(server, target);
        if (resolved) return;
        if (activity !== null) {
          const activityAgeSec = Math.floor(Date.now() / 1000) - activity;
          if (activityAgeSec < ACTIVITY_THRESHOLD_SEC) {
            lastDataTime = Date.now();
            consecutiveStillWorking = 0;
            const extendedDeadline = Date.now() + MAX_IDLE;
            if (extendedDeadline > phaseDeadline && extendedDeadline - phaseStartTime <= MAX_PHASE_DURATION_EXTENDED) {
              phaseDeadline = extendedDeadline;
              this.appendLog(taskId, unitId, 'command', {
                type: 'activity_extend',
                activityAgeSec,
                elapsedMs: Date.now() - phaseStartTime,
              });
            }
          }
        }

        const now = Date.now();
        if (now - lastDataTime > IDLE_TIMEOUT && now - lastClassifyTime > IDLE_TIMEOUT) {
          lastClassifyTime = now;
          this.appendLog(taskId, unitId, 'command', { type: 'pipe_idle_timeout', idleMs: now - lastDataTime });
          this.tmux.capturePane(server, target, -200).then(async (result) => {
            if (resolved) return;
            const bl = { phaseComplete: 0, question: 0 };
            const classification = await this.paneClassifier.classify(result.stdout, bl, doneMarker);
            this.appendLog(taskId, unitId, 'command', { type: 'pipe_idle_classified', status: classification.status });
            if (classification.status === 'still_working') {
              if (completionProbe) {
                const verified = await completionProbe();
                if (verified) {
                  this.appendLog(taskId, unitId, 'command', { type: 'completion_probe_verified' });
                  finish({ output: paneStream.getBuffer(), classification: { status: 'phase_complete' } });
                  return;
                }
              }
              consecutiveStillWorking++;
              if (consecutiveStillWorking >= MAX_CONSECUTIVE_STILL_WORKING) {
                this.appendLog(taskId, unitId, 'command', { type: 'still_working_limit', count: consecutiveStillWorking });
                finishStoppedOrVerified();
              } else {
                // Defer MAX_IDLE while the classifier says still_working;
                // bounded by the consecutive counter and MAX_PHASE_DURATION
                lastDataTime = Date.now();
              }
            } else {
              const fullOutput = paneStream.getBuffer() || result.stdout;
              finish({ output: fullOutput, classification });
            }
          }).catch(() => {});
        }
      }, HEARTBEAT_INTERVAL);

      const checkMaxIdle = () => {
        if (resolved) return;
        const idleMs = Date.now() - lastDataTime;
        if (idleMs >= MAX_IDLE) {
          this.appendLog(taskId, unitId, 'command', { type: 'pipe_timeout', idleMs });
          finishStoppedOrVerified();
        } else {
          timeoutTimer = setTimeout(checkMaxIdle, MAX_IDLE - idleMs + 1000);
        }
      };
      timeoutTimer = setTimeout(checkMaxIdle, MAX_IDLE);

      const checkPhaseMax = () => {
        if (resolved) return;
        const now = Date.now();
        if (now >= phaseDeadline) {
          const elapsedMs = now - phaseStartTime;
          this.appendLog(taskId, unitId, 'command', { type: 'phase_max_duration', elapsedMs });
          finishStoppedOrVerified();
        } else {
          phaseMaxTimer = setTimeout(checkPhaseMax, Math.min(phaseDeadline - now, 60_000));
        }
      };
      phaseMaxTimer = setTimeout(checkPhaseMax, MAX_PHASE_DURATION);

      signal.addEventListener('abort', () => {
        finish({ output: paneStream.getBuffer(), classification: { status: 'stopped' } });
      }, { once: true });
    });
  }
}
