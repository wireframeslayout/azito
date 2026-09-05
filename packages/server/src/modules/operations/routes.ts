import type { FastifyPluginCallback } from 'fastify';
import type { ExecuteTaskUseCase } from '../tasks/execution/ExecuteTaskUseCase';
import type { IWindowRepository } from '../windows/Window';
import type { SupervisorRegistry } from '../supervisors/SupervisorRegistry';
import type { AgentActivityMonitor } from './AgentActivityMonitor';
import { buildActivityDiagnostics } from './activityDiagnostics';
import type { PaneHandleResolver } from './PaneHandleResolver';

// ─── Types ───

export interface OperationsRouteOptions {
  executeTaskUseCase: ExecuteTaskUseCase;
  agentActivityMonitor: AgentActivityMonitor;
  supervisorRegistry: SupervisorRegistry;
  windowRepo: IWindowRepository;
  paneHandleResolver?: PaneHandleResolver;
}

export interface RunningOperation {
  unitId: number;
  taskId: number;
  target: string;
  serverName: string;
}

// ─── Plugin ───
//
// "Operation" (this module) is repurposed from the pre-Refine-B Operation
// entity (now Unit, see modules/units/) to mean a single execution run of a
// Unit against a task. There is no `operations` table — the run registry is
// ExecuteTaskUseCase's in-memory runningExecutions map.

const operationsRoutes: FastifyPluginCallback<OperationsRouteOptions> = (fastify, opts, done) => {
  const { executeTaskUseCase, agentActivityMonitor, supervisorRegistry, windowRepo, paneHandleResolver } = opts;

  // ── GET /api/operations ── currently running executions (unitId + taskId + tmux target)
  fastify.get('/api/operations', async () => {
    const running = executeTaskUseCase.getRunning();
    const operations: RunningOperation[] = [];
    for (const [unitId, executions] of Object.entries(running)) {
      for (const execution of executions) {
        operations.push({ unitId: Number(unitId), taskId: execution.taskId, target: execution.target, serverName: execution.serverName });
      }
    }
    return operations;
  });

  // ── GET /api/agent-activity ── snapshot of currently running agents (operation runs + manual agent windows)
  fastify.get('/api/agent-activity', async () => agentActivityMonitor.snapshot());

  // ── GET /api/debug/activity ── read-only Tier attribution for the activity
  // diagnostics panel (Settings → System). Answers "which tier actually decided
  // this window's state, and is Tier 0 alive?" without reading logs. Reads
  // already-collected state only; it never ticks the monitor or probes anything.
  fastify.get('/api/debug/activity', async () =>
    buildActivityDiagnostics(agentActivityMonitor, supervisorRegistry, windowRepo, paneHandleResolver));

  done();
};

export default operationsRoutes;
