import type { FastifyPluginCallback } from 'fastify';
import type { ExecuteTaskUseCase } from '../tasks/execution/ExecuteTaskUseCase';
import type { AgentActivityMonitor } from './AgentActivityMonitor';

// ─── Types ───

export interface OperationsRouteOptions {
  executeTaskUseCase: ExecuteTaskUseCase;
  agentActivityMonitor: AgentActivityMonitor;
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
  const { executeTaskUseCase, agentActivityMonitor } = opts;

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

  done();
};

export default operationsRoutes;
