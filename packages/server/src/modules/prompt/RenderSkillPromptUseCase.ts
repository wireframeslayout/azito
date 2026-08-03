import type { Task, ITaskRepository } from '../tasks/Task';
import type { IProjectRepository } from '../projects/Project';
import type { IUnitRepository } from '../units/Unit';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import type { IServerRepository } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import { renderForSkill } from './PhasePromptRenderer';
import type { SidekickPackage } from '../sidekicks/SidekickPackage';
import type { SidekickPackageLoader } from '../sidekicks/SidekickPackageLoader';
import { resolvePhaseSidekick, resolveNextPhase } from '../sidekicks/resolvePhaseSidekick';
import { renderSidekickBody } from '../sidekicks/renderSidekickBody';
import type { SidekickSyncService } from '../sidekicks/SidekickSyncService';
import { resolveSidekickDir } from '../sidekicks/SidekickSyncService';
import type { UnitTypeLoader } from '../sidekicks/UnitTypeLoader';
import { resolveTaskPromptVars } from './resolveTaskPromptVars';
import { resolveTaskServerName } from '../tasks/execution/TaskExecutionEnv';

export interface SkillPromptResult {
  phase: string;
  prompt: string;
  nextPhase: string | null;
}

/**
 * Backs `GET /api/phase-prompts/:phase?render=skill&task_id=` (used by the
 * harness azt-* skills). Resolves the phase's Sidekick package the same way
 * PhaseLoopRunner does (resolvePhaseSidekick), so the state-machine loop and
 * this compat endpoint never diverge. If the task has no Unit, uses the
 * 'devops' UnitType as fallback.
 */
export class RenderSkillPromptUseCase {
  constructor(
    private readonly taskRepo: ITaskRepository,
    private readonly projectRepo: IProjectRepository,
    private readonly unitRepo: IUnitRepository,
    private readonly projectServerRepo: IProjectServerRepository,
    private readonly sidekickLoader: SidekickPackageLoader,
    private readonly serverRepo: IServerRepository,
    private readonly transportFactory: TransportFactory,
    private readonly sidekickSyncService: SidekickSyncService,
    private readonly unitTypeLoader: UnitTypeLoader,
  ) {}

  async render(phase: string, taskId: number): Promise<SkillPromptResult> {
    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const project = this.projectRepo.findById(task.projectId);
    if (!project) {
      throw new Error(`Project not found: ${task.projectId}`);
    }

    const unit = task.unitId !== null ? this.unitRepo.findById(task.unitId) : null;
    const unitTypeName = unit?.unitType ?? 'devops';
    const unitType = this.unitTypeLoader.getOrThrow(unitTypeName);
    const phaseDef = unitType.phases.find((p) => p.name === phase);
    if (!phaseDef) {
      throw new Error(`Phase "${phase}" not found in UnitType "${unitTypeName}"`);
    }

    const phaseConfig = unit?.phaseConfig ?? null;
    const sidekick = resolvePhaseSidekick(this.sidekickLoader, phase, phaseConfig, phaseDef);
    const dir = await this.resolveDirForTask(task, sidekick);

    const vars = resolveTaskPromptVars(this.taskRepo, this.projectRepo, this.unitRepo, this.projectServerRepo, taskId);
    const expandedBody = renderSidekickBody(sidekick, vars, false, dir);
    const nextPhase = resolveNextPhase(phaseConfig, phase, unitType.phases);

    const nextPhaseDef = nextPhase ? unitType.phases.find((p) => p.name === nextPhase) : null;
    const prompt = renderForSkill(expandedBody, {
      capability: { questions: phaseDef.questions, testFailed: phaseDef.testFailed },
      nextPhaseSkillCommand: nextPhaseDef?.skillCommand,
    });

    return { phase, prompt, nextPhase };
  }

  private async resolveDirForTask(task: Pick<Task, 'projectId' | 'serverName'>, sidekick: SidekickPackage): Promise<string> {
    const serverName = resolveTaskServerName(task, this.projectServerRepo);
    if (!serverName) return sidekick.dir; // best-effort miss (read-only render)

    const server = this.serverRepo.findByName(serverName);
    if (!server || server.type === 'local') return sidekick.dir;

    const transport = this.transportFactory.getTransport(server);
    await this.sidekickSyncService.sync(server.name, transport, this.sidekickLoader.list());
    return resolveSidekickDir(sidekick, server);
  }
}
