import fs from 'fs';
import path from 'path';
import type { ITaskRepository, Task } from '../Task';
import type { TaskStatus } from '../TaskStatus';
import type { IUnitRepository, Unit } from '../../units/Unit';
import { usesHttpSignalPath } from '../../units/Unit';
import type { IExecutionLogRepository } from '../ExecutionLog';
import type { IServerRepository } from '../../servers/Server';
import type { IProjectRepository } from '../../projects/Project';
import type { IProjectServerRepository } from '../../projects/ProjectServer';
import type { TmuxClient } from '../../tmux/TmuxClient';
import type { ExecuteTaskUseCase } from '../execution/ExecuteTaskUseCase';
import type { SqliteAgentTurnRepository } from '../turns/SqliteAgentTurnRepository';
import type { AgentTurn } from '../turns/AgentTurn';
import { extractPhaseSummary } from '../extractPhaseSummary';
import { resolveTaskServerName, resolveMuxWorkspace, resolveUnitId } from '../execution/TaskExecutionEnv';
import type { UnitTypeLoader } from '../../sidekicks/UnitTypeLoader';
import type { UnitType, UnitTypePhase } from '../../sidekicks/UnitType';
import type { MuxRef } from '@azito/shared';

export interface RecoveryLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
}

const RECOVERABLE_STATUSES: TaskStatus[] = ['running', 'in_progress'];
const MAX_CONCURRENT = 3;

export class RecoverStuckTasksUseCase {
  constructor(
    private taskRepo: ITaskRepository,
    private unitRepo: IUnitRepository,
    private serverRepo: IServerRepository,
    private projectRepo: IProjectRepository,
    private projectServerRepo: IProjectServerRepository,
    private logRepo: IExecutionLogRepository,
    private tmuxClient: TmuxClient,
    private executeTaskUseCase: ExecuteTaskUseCase,
    private turnRepo: SqliteAgentTurnRepository,
    private logger: RecoveryLogger,
    private unitTypeLoader: UnitTypeLoader,
  ) {}

  private isRunning = false;

  async run(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      await this.doRun();
    } finally {
      this.isRunning = false;
    }
  }

  private async doRun(): Promise<void> {
    const stuckTasks: Task[] = [];
    for (const status of RECOVERABLE_STATUSES) {
      stuckTasks.push(...this.taskRepo.findByStatus(status));
    }
    if (stuckTasks.length === 0) return;

    const running = this.executeTaskUseCase.getRunning();
    const runningTaskIds = new Set(
      Object.values(running).flat().map((e) => e.taskId),
    );
    const candidates = stuckTasks.filter((t) => !runningTaskIds.has(t.id));
    if (candidates.length === 0) return;

    this.logger.info(`Startup recovery: found ${candidates.length} stuck task(s)`);

    const tasks = candidates.map((task) => () => this.recoverTask(task));
    await throttled(tasks, MAX_CONCURRENT);
  }

  private async recoverTask(task: Task): Promise<void> {
    const project = this.projectRepo.findById(task.projectId);
    const resolvedUnitId = resolveUnitId(task, project);
    if (resolvedUnitId === null) {
      this.logger.warn(`Recovery skip: no unit resolvable for task ${task.id} (no task.unitId and no project.defaultUnitId)`);
      return;
    }
    const unit = this.unitRepo.findById(resolvedUnitId);
    if (!unit) {
      this.logger.warn(`Recovery skip: unit ${resolvedUnitId} not found for task ${task.id}`);
      return;
    }

    let unitType: UnitType;
    try {
      unitType = this.unitTypeLoader.getOrThrow(unit.unitType);
    } catch {
      this.logger.warn(`Recovery skip: unitType "${unit.unitType}" not found for task ${task.id}`);
      return;
    }

    const resolvedServerName = resolveTaskServerName(task, this.projectServerRepo);
    if (!resolvedServerName) {
      this.logger.warn(`Recovery skip: cannot resolve server for task ${task.id}`);
      return;
    }
    const server = this.serverRepo.findByName(resolvedServerName);
    if (!server) return;
    if (server.type !== 'local' && !usesHttpSignalPath(unit.workerExecutionMode)) return;

    const muxWorkspace = resolveMuxWorkspace(task.projectId, resolvedServerName, this.projectServerRepo);
    const windowName = task.tmuxWindow || `task-${task.id}`;

    let target: string;
    try {
      const ref: MuxRef = { kind: 'tmux', workspace: muxWorkspace, window: windowName };
      target = await this.tmuxClient.resolvePane(server, ref, 1) as string;
    } catch {
      this.logger.warn(`Recovery skip: pane dead for task ${task.id} (${muxWorkspace}:${windowName})`);
      return;
    }

    try {
      await this.tmuxClient.capturePane(server, target);
    } catch {
      this.logger.warn(`Recovery skip: pane dead for task ${task.id} (${target})`);
      return;
    }

    const phaseNames = unitType.phases.map((p) => p.name);
    const phase = this.resolvePhase(task, phaseNames);
    if (!phase) {
      this.logger.warn(`Recovery skip: cannot determine phase for task ${task.id} (status=${task.status})`);
      return;
    }

    const phaseDef = unitType.phases.find((p) => p.name === phase);
    if (!phaseDef) {
      this.logger.warn(`Recovery skip: phase "${phase}" not found in unitType "${unit.unitType}" for task ${task.id}`);
      return;
    }

    await this.tmuxClient.sendKeys(server, target, ['Escape']);
    await sleep(500);

    if (usesHttpSignalPath(unit.workerExecutionMode)) {
      const turn = this.turnRepo.findLatestByTaskPhase(task.id, phase);
      if (turn && this.applyTurnRecovery(task, phase, turn, unit, phaseDef, unitType)) return;
    }

    const complete = await this.isPhaseComplete(task, phase, unit, phaseDef.pushVerify);

    if (complete) {
      const phaseIdx = phaseNames.indexOf(phase);
      const isLastPhase = phaseIdx === phaseNames.length - 1;
      if (isLastPhase) {
        this.taskRepo.updateStatus(task.id, 'review');
        this.logger.info(`Recovery: task ${task.id} last phase "${phase}" already complete -> review`);
        return;
      }
      const nextPhase = phaseNames[phaseIdx + 1];
      if (nextPhase) {
        this.taskRepo.updateStatus(task.id, 'running');
        this.taskRepo.updateCurrentPhase(task.id, nextPhase);
        this.logger.info(`Recovery: task ${task.id} advance ${phase} -> ${nextPhase}`);
      }
    } else {
      if (task.currentPhase !== phase) {
        this.taskRepo.updateStatus(task.id, 'running');
        this.taskRepo.updateCurrentPhase(task.id, phase);
      }
      this.logger.info(`Recovery: task ${task.id} retry current phase ${phase}`);
    }

    this.resume(unit, task);
  }

  private resume(unit: Unit, task: Task): void {
    this.turnRepo.supersedeRunning(task.id);

    this.executeTaskUseCase.resumeStateMachine(unit.id, task.id)
      .catch((err: Error) => this.logger.warn(`Recovery resume failed for task ${task.id}: ${err.message}`));
  }

  private applyTurnRecovery(task: Task, phase: string, turn: AgentTurn, unit: Unit, phaseDef: UnitTypePhase, unitType: UnitType): boolean {
    if (turn.status === 'questions') return this.recoverQuestions(task, turn);
    if (phaseDef.planApproval && turn.status === 'completed') return this.recoverCompletedPlanning(task, turn);
    if (phaseDef.testFailedRollbackTo && turn.status === 'test_failed') {
      this.recoverTestFailed(task, unit, phaseDef, unitType);
      return true;
    }
    return false;
  }

  private recoverQuestions(task: Task, turn: AgentTurn): boolean {
    const questions = this.readTurnQuestions(turn.id);
    if (questions === null) return false;
    this.taskRepo.update(task.id, { pendingQuestions: JSON.stringify(questions) } as Partial<Task>);
    this.taskRepo.updateStatus(task.id, 'waiting_input');
    this.logger.info(`Recovery: task ${task.id} restored pending questions -> waiting_input`);
    return true;
  }

  private recoverCompletedPlanning(task: Task, turn: AgentTurn): boolean {
    const output = this.readTurnOutput(turn.id);
    if (output !== null) {
      const { cleanOutput } = extractPhaseSummary(output);
      if (cleanOutput) {
        this.taskRepo.update(task.id, { planMarkdown: cleanOutput } as Partial<Task>);
      }
    }
    if (!task.requirePlanApproval) return false;
    this.taskRepo.updateStatus(task.id, 'phase_review');
    this.logger.info(`Recovery: task ${task.id} planning complete -> phase_review (awaiting approval)`);
    return true;
  }

  private recoverTestFailed(task: Task, unit: Unit, phaseDef: UnitTypePhase, unitType: UnitType): void {
    const maxSelfReview = task.selfReviewMaxAttempts ?? unit.selfReviewMaxAttempts ?? 2;
    const phaseNames = unitType.phases.map((p) => p.name);
    if (task.selfReviewCount + 1 < maxSelfReview && phaseDef.testFailedRollbackTo) {
      const selfReviewCount = task.selfReviewCount + 1;
      this.taskRepo.update(task.id, { selfReviewCount } as Partial<Task>);
      this.taskRepo.updateStatus(task.id, 'running');
      this.taskRepo.updateCurrentPhase(task.id, phaseDef.testFailedRollbackTo);
      this.logger.info(`Recovery: task ${task.id} test failed -> ${phaseDef.testFailedRollbackTo} (self-review ${selfReviewCount}/${maxSelfReview})`);
    } else {
      const currentIdx = phaseNames.indexOf(phaseDef.name);
      const nextPhase = phaseNames[currentIdx + 1];
      if (nextPhase) {
        this.taskRepo.updateStatus(task.id, 'running');
        this.taskRepo.updateCurrentPhase(task.id, nextPhase);
        this.logger.info(`Recovery: task ${task.id} test failed at self-review limit -> ${nextPhase}`);
      } else {
        this.taskRepo.updateStatus(task.id, 'review');
        this.logger.info(`Recovery: task ${task.id} test failed at self-review limit (last phase) -> review`);
        return;
      }
    }
    this.resume(unit, task);
  }

  private readTurnOutput(turnId: number): string | null {
    const event = this.turnRepo.findLatestEventByType(turnId, 'complete');
    if (!event?.payload) return null;
    try {
      const parsed = JSON.parse(event.payload) as { output?: unknown };
      return typeof parsed.output === 'string' && parsed.output.length > 0 ? parsed.output : null;
    } catch {
      return null;
    }
  }

  private readTurnQuestions(turnId: number): unknown[] | null {
    const event = this.turnRepo.findLatestEventByType(turnId, 'questions');
    if (!event?.payload) return null;
    try {
      const parsed = JSON.parse(event.payload) as { questions?: unknown };
      return Array.isArray(parsed.questions) ? parsed.questions : null;
    } catch {
      return null;
    }
  }

  private resolvePhase(task: Task, phaseNames: string[]): string | null {
    if (task.currentPhase && phaseNames.includes(task.currentPhase)) {
      return task.currentPhase;
    }

    const logs = this.logRepo.findByTask(task.id);
    for (let i = logs.length - 1; i >= 0; i--) {
      if (logs[i].type !== 'command') continue;
      try {
        const parsed = JSON.parse(logs[i].content) as Record<string, unknown>;
        if (parsed.type === 'phase_prompt' && typeof parsed.phase === 'string') {
          if (phaseNames.includes(parsed.phase)) return parsed.phase;
        }
      } catch { /* skip */ }
    }

    return null;
  }

  private async isPhaseComplete(task: Task, phase: string, unit: Unit, pushVerify: boolean): Promise<boolean> {
    const latestTurn = this.turnRepo.findLatestByTaskPhase(task.id, phase);

    if (latestTurn && latestTurn.status !== 'running' && latestTurn.status !== 'superseded') {
      if (latestTurn.status === 'completed') return true;
      if (!pushVerify) return false;
    } else if (unit.workerExecutionMode === 'tmux-pipe') {
      const found = this.findDoneMarkerInSignalFiles(task, phase);
      if (found) return true;
      if (!pushVerify) return false;
    } else if (!pushVerify) {
      return false;
    }

    if (pushVerify) {
      return this.executeTaskUseCase.isPushCompleted(task.id);
    }

    return false;
  }

  private findDoneMarkerInSignalFiles(task: Task, phase: string): boolean {
    const logs = this.logRepo.findByTask(task.id);
    const phasePromptLogs = logs
      .filter((l) => l.type === 'command')
      .map((l) => {
        try {
          return { ...l, parsed: JSON.parse(l.content) as Record<string, unknown> };
        } catch {
          return null;
        }
      })
      .filter((l): l is NonNullable<typeof l> =>
        l !== null && l.parsed.type === 'phase_prompt' && l.parsed.phase === phase,
      );

    const lastPrompt = phasePromptLogs[phasePromptLogs.length - 1];
    if (!lastPrompt) return false;

    const doneMarker = lastPrompt.parsed.doneMarker as string | undefined;
    if (!doneMarker) return false;

    const sigPrefix = `azito-pipe-${task.id}-sig-`;
    try {
      const tmpFiles = fs.readdirSync('/tmp');
      const sigFiles = tmpFiles.filter((f) => f.startsWith(sigPrefix) && f.endsWith('.log'));
      for (const sigFile of sigFiles) {
        const content = fs.readFileSync(path.join('/tmp', sigFile), 'utf-8');
        if (content.includes(doneMarker)) return true;
      }
    } catch {
      // /tmp read failed
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttled(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const task of tasks) {
    const p = task().finally(() => { executing.delete(p); });
    executing.add(p);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}
