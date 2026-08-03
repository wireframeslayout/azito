// ─── Port: task → prompt-template vars (Issue #263 Phase 5) ───
//
// GET /api/sidekicks/:name?render=1&task_id=... (modules/sidekicks/routes.ts)
// needs to expand a Sidekick body with the same task/project/unit vars
// RenderSkillPromptUseCase uses, but modules/sidekicks is a mid-layer module
// that must not depend on tasks/Task, projects/Project, or units/Unit
// (all upper-layer). This interface is the port: modules/sidekicks depends only
// on this shape, and modules/prompt (which already has permission to reach
// those entities) provides the implementation — injected at the composition
// root (app/buildServer.ts) so the dependency direction stays sidekicks ⇐ prompt,
// never the reverse.

import type { SidekickPackage } from './SidekickPackage';

// Matches the `vars` shape expandPromptTemplate/renderSidekickBody accept
// throughout modules/prompt: expected keys are task/project/projectServer/
// selfReview/module, each a flat string map.
export type TaskPromptVars = Record<string, Record<string, string>>;

export interface ITaskPromptVarsResolver {
  /** Fail-fast: throws if the task or its project cannot be found. */
  resolve(taskId: number): TaskPromptVars;

  /**
   * Resolves `{{sidekick.dir}}` for `pkg` as seen by `taskId`'s execution
   * server (Issue #263 Phase 6): `pkg.dir` for local, the synced remote path
   * for ssh/agent (ensuring the sync first — fail-fast, throws on transfer
   * failure). When the task's server cannot be resolved (no serverName and
   * zero/ambiguous project_servers), this is a read-only render — falls back
   * to `pkg.dir` rather than throwing, mirroring resolveTaskServerName's
   * "best-effort miss for prompt rendering" contract.
   */
  resolveDir(taskId: number, pkg: Pick<SidekickPackage, 'name' | 'dir'>): Promise<string>;
}
