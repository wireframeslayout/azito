import { createHash } from 'crypto';
import type { Task } from '../Task';
import type { IUnitRepository, SubagentConfig, Unit } from '../../units/Unit';
import type { IProjectRepository, ProjectDetail } from '../../projects/Project';
import type { IProjectServerRepository, ProjectServer } from '../../projects/ProjectServer';
import type { PhaseConfig } from '../../sidekicks/PhaseConfig';
import type { SidekickPackageLoader } from '../../sidekicks/SidekickPackageLoader';
import type { UnitTypeLoader } from '../../sidekicks/UnitTypeLoader';
import { resolvePhaseSidekick, resolveCurrentPhaseIndex } from '../../sidekicks/resolvePhaseSidekick';
import { resolveUnitId, resolveTaskServerName, resolveBaseBranch } from './TaskExecutionEnv';

/**
 * Execution manifest (Issue #328 fifth-round review).
 *
 * Why this file exists: the approval fingerprint used to hash a hand-picked
 * list of `tasks` table columns (title, description, unitId, serverName,
 * ...). Every review round found one more field that reaches a worker's
 * prompt or targeting decision without being on that list — because the
 * list was of raw task fields, not of what execution actually resolves them
 * to. `task.unitId === null` was the sharpest example: the fingerprint
 * hashed `null`, but ExecuteTaskUseCase runs `resolveUnitId()`, which falls
 * back to `project.defaultUnitId` — so editing the *project*, never the
 * task, could silently move an already-approved task onto a different Unit
 * (different system prompt, different worker) without invalidating the
 * approval.
 *
 * The fix: stop hashing raw fields and hash the RESOLVED execution manifest
 * instead — "if this task ran right now, which Unit, which server
 * config, which branches, which subagent config would it actually use".
 * `resolveExecutionManifest()` below calls the exact same resolver
 * functions ExecuteTaskUseCase/TaskRestoreService call to run a task
 * (`resolveUnitId`, `resolveTaskServerName`, `resolveBaseBranch` — all in
 * TaskExecutionEnv.ts) rather than re-implementing the resolution for
 * approval purposes. A second, slightly-different resolution path is
 * exactly how the previous holes opened up.
 *
 * checkExecutionGate() (ExecutionGate.ts) stays a pure comparison: it takes
 * an already-resolved manifest hash and project_servers policy, and never
 * reads a repository itself (Resolve at the Boundary) — every call site
 * (ExecuteTaskUseCase, TaskRestoreService, WindowRespawnService,
 * units/routes.ts's approve-execution handler) resolves via this module
 * first, then hands the gate the resolved hash.
 *
 * What's included, and why:
 * - unit: the resolved Unit's id plus every field that changes what a
 *   worker is told to do or how it's launched (systemPrompt, workerType/
 *   Model/ExtraArgs, workerExecutionMode, workerRuntime, unitType). `id` is
 *   included even though the content fields already capture "what runs" —
 *   otherwise re-pointing a task at a different Unit with byte-identical
 *   config wouldn't invalidate approval, which is still a targeting change
 *   a human should re-confirm.
 * - server: the resolved server name plus its project_servers row's content
 *   (workingDirectory, branch) — NOT the per-run worktree path (see
 *   "deliberately excluded" below).
 * - branches: base/target/work, each resolved the same way execution
 *   resolves them (resolveBaseBranch; task.targetBranch/branch directly,
 *   same as before).
 * - task: title/description/workingDirectory — title/description are
 *   interpolated directly into the worker's prompt (resolveTaskPromptVars.ts);
 *   workingDirectory is the task-level override (migration 032) that,
 *   combined with server.workingDirectory above, decides where execute()
 *   actually runs — a field the raw-column fingerprint carried but that was
 *   dropped in the move to the resolved-manifest approach (Issue #328
 *   sixth-round review regression: it was on the original hand-picked column
 *   list this file's own history describes above).
 * - subagent: review/implement config, resolved the same way
 *   PhaseLoopRunner resolves it for an actual run (task override ??
 *   Unit default) — a task with no override still inherits the Unit's
 *   subagent config, so an edit to the UNIT's default must also be able to
 *   invalidate approval, not just a task-level override.
 * - project.sidekickPrompt: injected into every phase prompt by
 *   resolveTaskPromptVars.ts (`[project.sidekickPrompt, unit.systemPrompt]`) —
 *   editing it changes what the worker is told exactly like editing
 *   unit.systemPrompt does, so it must invalidate approval the same way.
 * - unit.phaseConfig: decides which Sidekick package renders each phase
 *   (resolvePhaseSidekick.ts) and which phases are enabled/skipped
 *   (resolveEnabledPhases) — reassigning a phase to a different package or
 *   toggling one off/on changes what runs without changing anything else on
 *   this list.
 * - sidekick: the resolved Sidekick package for the phase that will actually
 *   run next (resolveCurrentPhaseIndex — same "resume point" resolution
 *   PhaseLoopRunner.stateMachineLoop uses, so approval always reflects the
 *   phase execution really resumes at, not just phase 0). Only a content
 *   digest of the package body is hashed (see hashExecutionManifest), not the
 *   full text — this is the instruction text actually sent to the worker;
 *   without it, editing a user-layer Sidekick package (`data/sidekicks/`)
 *   after approval could swap in arbitrary instructions post-approval with no
 *   fingerprint change at all. Resolution failure (missing/misconfigured
 *   package) is tolerated here the same way a null unit/server is elsewhere
 *   — the real run's own resolvePhaseSidekick() call still fails fast; this
 *   manifest only needs to detect drift, not duplicate that validation.
 *
 * Deliberately excluded (values that change on every run of an
 * ALREADY-approved task, or that a human never reviews as "what will run"):
 * a fingerprint built from these would self-invalidate the moment the
 * approved run actually executes, turning "approve once" into an infinite
 * pending_approval loop — this is the number one failure mode to check for
 * whenever a field is added here.
 * - worktreePath / worktreeBranch: system-overwritten with the freshly
 *   created worktree's real path every time a run starts (ExecuteTaskUseCase.
 *   execute/TaskRestoreService.restore write these right after the gate
 *   check that approved the run) — never a value a human approved in advance.
 *   `branches.work` above uses `task.branch` instead, which the client sets
 *   and the system does not overwrite mid-run for this purpose.
 * - tmuxWindow, agentSessionId, pendingOperation(WindowId): run-scoped
 *   bookkeeping, not execution content or target.
 * - status, priority, selfReviewCount, planMarkdown, changedFiles, prUrl,
 *   summaryJson: workflow state or worker-authored output, not input the
 *   approval needs to cover.
 * - selfReviewMaxAttempts (task or Unit): a loop-iteration count, not prompt
 *   content or a run target — worst case is more iterations of an
 *   already-approved phase.
 * - task.skipPr: selects between two fixed template strings, never
 *   attacker-authored text.
 * - requirePlanApproval: can only be strengthened for an untrusted task
 *   (enforced by the PUT handler itself), so there's no dangerous direction
 *   left to guard against.
 * - source, sourceRef: `source` is already the one field this whole gate
 *   distrusts on principle (see Task.inputTrust's doc comment); neither is
 *   read by any prompt-building/targeting code path.
 */

export interface ResolvedExecutionManifest {
  unit: {
    id: number;
    systemPrompt: string | null;
    workerType: string | null;
    workerModel: string | null;
    workerExtraArgs: string | null;
    workerExecutionMode: string;
    workerRuntime: string;
    unitType: string;
    phaseConfig: PhaseConfig | null;
  } | null;
  server: {
    name: string | null;
    workingDirectory: string | null;
    branch: string | null;
  };
  branches: {
    base: string;
    target: string;
    work: string;
  };
  task: {
    title: string;
    description: string;
    workingDirectory: string | null;
  };
  subagent: {
    review: SubagentConfig | null;
    implement: SubagentConfig | null;
  };
  project: {
    sidekickPrompt: string | null;
  };
  /**
   * The Sidekick package that will render the phase this task resumes at
   * next (see resolveCurrentPhaseIndex/resolvePhaseSidekick). `phase` is
   * null when no Unit/UnitType/enabled phase can be resolved (mirrors the
   * `unit: null` tolerance elsewhere in this manifest); `name`/`bodyDigest`
   * are null when the phase resolves but the package itself does not
   * (misconfigured phaseConfig override, no default package for the tag) —
   * the real run's own resolvePhaseSidekick() call still fails fast on that,
   * this manifest only needs to notice when it changes.
   */
  sidekick: {
    phase: string | null;
    name: string | null;
    bodyDigest: string | null;
  };
}

export interface ExecutionManifestResolution {
  manifest: ResolvedExecutionManifest;
  project: ProjectDetail | null;
  unit: Unit | null;
  serverName: string | null;
  projectServer: ProjectServer | null;
}

export interface ExecutionManifestDeps {
  unitRepo: IUnitRepository;
  projectRepo: IProjectRepository;
  projectServerRepo: IProjectServerRepository;
  // Needed to resolve the `sidekick` field above — the same
  // UnitTypeLoader/SidekickPackageLoader singletons PhaseLoopRunner is
  // wired with (see app/wiring.ts), so the package this manifest hashes is
  // read from the exact same in-memory/mtime-cached source a real run reads
  // from, not a second load.
  unitTypeLoader: UnitTypeLoader;
  sidekickLoader: SidekickPackageLoader;
}

/**
 * Resolves the execution manifest for `task` — see the module doc comment
 * above for what's in it and why. Every field is resolved through the same
 * functions the actual execution path uses (TaskExecutionEnv.ts), so the
 * manifest a human approves is guaranteed to match what a subsequent run
 * resolves, as long as nothing covered by it has changed in between.
 *
 * Tolerates an unresolvable Unit or server (returns `null` for that part of
 * the manifest) rather than throwing — callers that require a resolvable
 * Unit/server to run at all (ExecuteTaskUseCase.resolveExecutionEnv) already
 * fail fast on their own before reaching the gate; TaskRestoreService.restore
 * historically tolerates a null Unit (an archived task whose Unit was
 * deleted), so this resolver must too, to stay a faithful mirror of what
 * execution actually does.
 */
export function resolveExecutionManifest(task: Task, deps: ExecutionManifestDeps): ExecutionManifestResolution {
  const project = deps.projectRepo.findById(task.projectId);
  const unitId = resolveUnitId(task, project);
  const unit = unitId !== null ? deps.unitRepo.findById(unitId) : null;
  const serverName = resolveTaskServerName(task, deps.projectServerRepo);
  const projectServer = serverName ? deps.projectServerRepo.find(task.projectId, serverName) : null;
  const baseBranch = resolveBaseBranch(task, projectServer, project);

  // Same resolution PhaseLoopRunner.stateMachineLoop uses to pick the phase
  // a run resumes at (resolveCurrentPhaseIndex), then resolvePhaseSidekick
  // for the package that renders it — both shared functions, not
  // reimplemented here, so this can never drift from what a real run
  // actually resolves (Issue #328 sixth-round review).
  const unitType = unit ? deps.unitTypeLoader.get(unit.unitType) : undefined;
  let sidekickPhase: string | null = null;
  let sidekickName: string | null = null;
  let sidekickBodyDigest: string | null = null;
  if (unit && unitType) {
    const { enabledPhases, index } = resolveCurrentPhaseIndex(unit.phaseConfig, unitType.phases, task.currentPhase);
    const phase = enabledPhases[index] ?? null;
    sidekickPhase = phase;
    const phaseDef = phase ? unitType.phases.find((p) => p.name === phase) : undefined;
    if (phase && phaseDef) {
      try {
        const sidekick = resolvePhaseSidekick(deps.sidekickLoader, phase, unit.phaseConfig, phaseDef);
        sidekickName = sidekick.name;
        sidekickBodyDigest = createHash('sha256').update(sidekick.body).digest('hex');
      } catch {
        // Misconfigured phaseConfig override / no default package for the
        // tag — tolerated here (see ResolvedExecutionManifest.sidekick's doc
        // comment); the real run's own resolvePhaseSidekick() call still
        // fails fast on this.
      }
    }
  }

  const manifest: ResolvedExecutionManifest = {
    unit: unit
      ? {
          id: unit.id,
          systemPrompt: unit.systemPrompt,
          workerType: unit.workerType,
          workerModel: unit.workerModel,
          workerExtraArgs: unit.workerExtraArgs,
          workerExecutionMode: unit.workerExecutionMode,
          workerRuntime: unit.workerRuntime,
          unitType: unit.unitType,
          phaseConfig: unit.phaseConfig,
        }
      : null,
    server: {
      name: serverName,
      workingDirectory: projectServer?.workingDirectory ?? null,
      branch: projectServer?.branch ?? null,
    },
    branches: {
      base: baseBranch,
      target: task.targetBranch ?? '',
      work: task.branch ?? '',
    },
    task: {
      title: task.title,
      description: task.description ?? '',
      workingDirectory: task.workingDirectory ?? null,
    },
    subagent: {
      // Same precedence PhaseLoopRunner applies at run time (task override,
      // then the Unit's default) — a task with no override still inherits
      // whatever the Unit is currently configured with.
      review: task.reviewSubagent ?? unit?.reviewSubagent ?? null,
      implement: task.implementSubagent ?? unit?.implementSubagent ?? null,
    },
    project: {
      sidekickPrompt: project?.sidekickPrompt ?? null,
    },
    sidekick: {
      phase: sidekickPhase,
      name: sidekickName,
      bodyDigest: sidekickBodyDigest,
    },
  };

  return { manifest, project, unit, serverName, projectServer };
}

function normalizeSubagent(cfg: SubagentConfig | null): { enabled: boolean; provider: string; model: string } | null {
  if (!cfg) return null;
  return { enabled: cfg.enabled, provider: cfg.provider, model: cfg.model };
}

/**
 * Deterministic fingerprint of a resolved execution manifest. Not a security
 * hash (collision resistance beyond "don't false-match on a real change"
 * isn't a requirement here) — sha256 is used simply because Node ships it
 * and it's already the project's convention for content fingerprints
 * (see the former ExecutionGate.hashApprovedTaskFingerprint).
 *
 * Fields are combined via JSON.stringify with an explicit, fixed key order
 * (not string concatenation, and not the field order the DB happens to
 * return): JSON.stringify escapes embedded quotes/backslashes/control
 * characters, and every key here is written literally in source rather than
 * derived from iterating user-controlled data, so there is no delimiter an
 * attacker could inject to make content "move" from one field into another
 * and still hash-collide with a previously-approved fingerprint.
 */
export function hashExecutionManifest(manifest: ResolvedExecutionManifest): string {
  const normalized = JSON.stringify({
    unit: manifest.unit
      ? {
          id: manifest.unit.id,
          systemPrompt: manifest.unit.systemPrompt ?? '',
          workerType: manifest.unit.workerType ?? '',
          workerModel: manifest.unit.workerModel ?? '',
          workerExtraArgs: manifest.unit.workerExtraArgs ?? '',
          workerExecutionMode: manifest.unit.workerExecutionMode,
          workerRuntime: manifest.unit.workerRuntime,
          unitType: manifest.unit.unitType,
          phaseConfig: manifest.unit.phaseConfig ?? null,
        }
      : null,
    server: {
      name: manifest.server.name ?? '',
      workingDirectory: manifest.server.workingDirectory ?? '',
      branch: manifest.server.branch ?? '',
    },
    branches: {
      base: manifest.branches.base,
      target: manifest.branches.target,
      work: manifest.branches.work,
    },
    task: {
      title: manifest.task.title,
      description: manifest.task.description,
      workingDirectory: manifest.task.workingDirectory ?? '',
    },
    subagent: {
      review: normalizeSubagent(manifest.subagent.review),
      implement: normalizeSubagent(manifest.subagent.implement),
    },
    project: {
      sidekickPrompt: manifest.project.sidekickPrompt ?? '',
    },
    sidekick: {
      phase: manifest.sidekick.phase ?? '',
      name: manifest.sidekick.name ?? '',
      bodyDigest: manifest.sidekick.bodyDigest ?? '',
    },
  });
  return createHash('sha256').update(normalized).digest('hex');
}
