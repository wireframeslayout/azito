import type { PhaseConfig } from '../sidekicks/PhaseConfig';

export type WorkerExecutionMode = 'tmux-pipe' | 'http-signal';
export type WorkerRuntime = 'tui' | 'headless' | 'api';

export function usesHttpSignalPath(mode: WorkerExecutionMode): boolean {
  return mode === 'http-signal';
}

export interface SubagentConfig {
  enabled: boolean;
  provider: string;
  model: string;
}

/**
 * A Unit is the team that runs a task: it owns both behavior (system prompt,
 * self-review config, subagent delegation, per-phase Sidekick config via
 * `phaseConfig` — resolved via modules/sidekicks/resolvePhaseSidekick.ts) and
 * runtime ("what runs it": worker CLI type/model/extra args and execution
 * signaling mode). Formerly split
 * across Operation (behavior) and WorkerProfile (runtime) — merged back into
 * one entity in Issue #263 Refine B, since in practice every Operation had
 * exactly one WorkerProfile driving it.
 *
 * "Where it runs" stays separate: Task.serverName / project_servers (Issue
 * #263 Phase 2).
 *
 * "Operation" now means a single execution run of a Unit against a task —
 * see ExecuteTaskUseCase.getRunning() and GET /api/operations.
 */
export interface Unit {
  id: number;
  name: string;
  unitType: string;
  systemPrompt: string | null;
  selfReviewMaxAttempts: number;
  reviewSubagent: SubagentConfig | null;
  implementSubagent: SubagentConfig | null;
  phaseConfig: PhaseConfig | null;
  workerType: string | null;
  workerModel: string | null;
  workerExtraArgs: string | null;
  workerExecutionMode: WorkerExecutionMode;
  workerRuntime: WorkerRuntime;
  createdAt: string;
  updatedAt: string;
}

export interface IUnitRepository {
  findAll(): Unit[];
  findById(id: number): Unit | null;
  create(data: Omit<Unit, 'id' | 'createdAt' | 'updatedAt'>): number;
  update(id: number, data: Partial<Unit>): void;
  delete(id: number): void;
}
