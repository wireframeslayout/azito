import type { ITaskRepository } from '../tasks/Task';
import type { IProjectRepository } from '../projects/Project';
import type { IUnitRepository } from '../units/Unit';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import type { IServerRepository } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { ITaskPromptVarsResolver, TaskPromptVars } from '../sidekicks/ITaskPromptVarsResolver';
import type { SidekickPackage } from '../sidekicks/SidekickPackage';
import type { SidekickPackageLoader } from '../sidekicks/SidekickPackageLoader';
import type { SidekickSyncService } from '../sidekicks/SidekickSyncService';
import { resolveSidekickDir } from '../sidekicks/SidekickSyncService';
import { resolveTaskPromptVars } from './resolveTaskPromptVars';
import { resolveTaskServerName } from '../tasks/execution/TaskExecutionEnv';

/**
 * Concrete implementation of the ITaskPromptVarsResolver port (defined in
 * modules/sidekicks) — injected into sidekicksRoutes so `GET /api/sidekicks/:name
 * ?render=1&task_id=` can expand a Sidekick body with the same vars
 * RenderSkillPromptUseCase uses, without modules/sidekicks depending upward on
 * tasks/projects/units (Issue #263 Phase 5). resolveDir additionally
 * ensures the target server has the merged Sidekick package tree synced
 * before resolving `{{sidekick.dir}}` for it (Issue #263 Phase 6).
 */
export class TaskPromptVarsResolver implements ITaskPromptVarsResolver {
  constructor(
    private readonly taskRepo: ITaskRepository,
    private readonly projectRepo: IProjectRepository,
    private readonly unitRepo: IUnitRepository,
    private readonly projectServerRepo: IProjectServerRepository,
    private readonly serverRepo: IServerRepository,
    private readonly transportFactory: TransportFactory,
    private readonly sidekickLoader: SidekickPackageLoader,
    private readonly sidekickSyncService: SidekickSyncService,
  ) {}

  resolve(taskId: number): TaskPromptVars {
    return resolveTaskPromptVars(this.taskRepo, this.projectRepo, this.unitRepo, this.projectServerRepo, taskId);
  }

  async resolveDir(taskId: number, pkg: Pick<SidekickPackage, 'name' | 'dir'>): Promise<string> {
    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const serverName = resolveTaskServerName(task, this.projectServerRepo);
    if (!serverName) return pkg.dir; // best-effort miss (read-only render), same contract as resolveTaskServerName

    const server = this.serverRepo.findByName(serverName);
    if (!server || server.type === 'local') return pkg.dir;

    const transport = this.transportFactory.getTransport(server);
    await this.sidekickSyncService.sync(server.name, transport, this.sidekickLoader.list());
    return resolveSidekickDir(pkg, server);
  }
}
