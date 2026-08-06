import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Task } from '../Task';
import type { IUnitRepository, SubagentConfig, Unit } from '../../units/Unit';
import type { IProjectRepository, ProjectDetail } from '../../projects/Project';
import type { IProjectServerRepository, ProjectServer } from '../../projects/ProjectServer';
import type { IServerRepository } from '../../servers/Server';
import type { SqliteProjectSecretRepository } from '../../projects/SqliteProjectSecretRepository';
import type { PhaseConfig } from '../../sidekicks/PhaseConfig';
import type { SidekickPackageLoader } from '../../sidekicks/SidekickPackageLoader';
import type { UnitTypeLoader } from '../../sidekicks/UnitTypeLoader';
import { resolvePhaseSidekick, resolveEnabledPhases } from '../../sidekicks/resolvePhaseSidekick';
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
 * - server: the resolved server name, its project_servers row's content
 *   (workingDirectory, branch) — NOT the per-run worktree path (see
 *   "deliberately excluded" below) — AND, since Issue #328 tenth-round
 *   review, the fields of the resolved `servers` row (via IServerRepository)
 *   that decide WHICH MACHINE a run actually executes on: `type` (local/
 *   agent), `host`, `agentPort`, `sshHost`. Execution resolves a target
 *   machine from `serverName` at run time via `serverRepo.findByName()` —
 *   TransportFactory picks local/SSH/agent based on exactly these fields —
 *   so hashing only the NAME left a hole: re-registering the same server
 *   name against a different host/type changed nothing this fingerprint
 *   covered, letting an already-approved task silently execute on a
 *   different machine post-approval. `agentToken` is deliberately excluded
 *   (see below) — everything else on `ServerConfig` is either an auth
 *   secret or state that mutates independently of "what machine does this
 *   task run on" (also see below).
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
 * - secrets.namesDigest: a sha256 digest of the SORTED set of project
 *   secret NAMES (ExecuteTaskUseCase.buildExtraEnv injects every
 *   `project_secrets` row for task.projectId as `AZITO_SECRET_<name>` env
 *   vars into the task's tmux window — see the Issue #328 tenth-round
 *   review finding this closes). Sorted so the digest is independent of
 *   insertion order — the same "no delimiter for an attacker to move
 *   content across a field boundary" property hashExecutionManifest's own
 *   doc comment describes applies here too (see hashSecretNameSet()).
 *   Values are deliberately NOT hashed or otherwise included, for two
 *   reasons: (1) it would put plaintext secret material on a path that
 *   feeds a hash computation, for no security benefit over hashing just the
 *   names; (2) a value rotation (e.g. a leaked API key being replaced) would
 *   then invalidate every already-approved task using that secret — the
 *   same self-invalidation failure mode this file's "deliberately excluded"
 *   section below warns about. The consequence of that choice is deliberate
 *   and asymmetric: adding a NEW secret to the project changes the digest
 *   (an untrusted task gaining access to something a human never reviewed
 *   must re-prompt approval); replacing an EXISTING secret's value, with the
 *   same name, does not (the human already approved that name being
 *   injected — only the value changed, and Resolve at the Boundary already
 *   treats "which secrets reach this task" as the thing being approved, not
 *   "what are they set to today").
 * - unit.phaseConfig: decides which Sidekick package renders each phase
 *   (resolvePhaseSidekick.ts) and which phases are enabled/skipped
 *   (resolveEnabledPhases) — reassigning a phase to a different package or
 *   toggling one off/on changes what runs without changing anything else on
 *   this list.
 * - sidekicks: the resolved Sidekick package for EVERY enabled phase of the
 *   UnitType (resolveEnabledPhases), in the UnitType's declared order, in
 *   phase order. Eighth-round review: this used to be sliced from the
 *   "resume point" onward (resolveCurrentPhaseIndex, keyed off
 *   task.currentPhase) — but task.currentPhase moves forward on every
 *   ordinary run (PhaseLoopRunner advances it as phases complete), so that
 *   slice changed on its own mid-run and self-invalidated an approval the
 *   moment execution progressed past the approved phase (approve at
 *   planning -> currentPhase becomes 'implementing' -> the very next gate
 *   check hashes a shorter remainder and throws). Hashing ALL enabled
 *   phases, unconditionally, removes that dependency on a value execution
 *   itself mutates, while still catching every case the resume-point slice
 *   was added for (seventh-round review): a package rewrite targeting a
 *   later phase, or phases being reordered/added/removed via phaseConfig (a
 *   change unit.phaseConfig above already covers by itself, but the ordered
 *   list here is what makes a reordering-without-content-change visible
 *   too) still changes this list regardless of where task.currentPhase
 *   happens to be. Only a content digest of each package body is hashed
 *   (see hashExecutionManifest), not the full text — this is the
 *   instruction text actually sent to the worker; without it, editing a
 *   user-layer Sidekick package (`data/sidekicks/`) after approval could
 *   swap in arbitrary instructions post-approval with no fingerprint change
 *   at all. Resolution failure for a given phase (missing/misconfigured
 *   package) is tolerated here the same way a null unit/server is elsewhere
 *   — the real run's own resolvePhaseSidekick() call still fails fast; this
 *   manifest only needs to detect drift, not duplicate that validation.
 * - respawn: present only when resolveExecutionManifest is called from
 *   WindowRespawnService (see its own doc comment below) — null for every
 *   other call site (ExecuteTaskUseCase, TaskRestoreService, the
 *   approve-execution handler for non-respawn operations). Carries the
 *   values that actually decide what a respawn launches (target server,
 *   worker model, per-pane worker types) which live on the persisted
 *   Window row, NOT on anything resolveUnitId/resolveTaskServerName touch
 *   — see WindowRespawnService's module doc comment (Issue #328
 *   eighth-round review finding 2) for why the two can diverge.
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
 * - server.agentToken: an authentication credential, not a targeting
 *   decision — `TransportFactory` uses it to AUTHENTICATE to the host
 *   `server.host`/`server.agentPort` already identify, it doesn't change
 *   WHICH host that is. Including it would make a routine credential
 *   rotation (`azito token rotate`-style agent re-provisioning) invalidate
 *   every already-approved task on that server — the self-invalidation
 *   failure mode this section exists to prevent.
 * - server.agentVersion: bumped by AgentUpdater whenever the remote agent
 *   process auto-updates, entirely independent of any human decision about
 *   what/where a task runs.
 * - server.sshHostFingerprint: TOFU host-key pinning state, mutated by
 *   `fingerprintStore.saveFingerprint()` on legitimate key rotation (see
 *   app/wiring.ts) — a host-identity integrity mechanism, not something a
 *   human reviews as "which server will this task run on" (that's
 *   `server.sshHost`, already covered above).
 * - server.muxRuntime, server.createdAt: `muxRuntime` selects how tmux
 *   itself is managed on an already-identified host (system vs. managed
 *   process), not which host; `createdAt` is immutable registration
 *   metadata. Neither is a targeting decision.
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
 * - task.currentPhase: mutated by PhaseLoopRunner as an ALREADY-approved run
 *   advances from phase to phase — the textbook case the exclusion list
 *   above warns about. It used to influence this manifest indirectly (as
 *   the slice point into `sidekicks`, see that field's doc comment above);
 *   that was the eighth-round review's self-invalidation bug. Not read
 *   anywhere in this file anymore.
 */

/**
 * Recursively collects every regular file under `dir`, returning paths
 * relative to `dir` with forward slashes (platform-independent, deterministic
 * comparison). Symlinks are excluded — `fs.Dirent` entries from
 * `withFileTypes: true` use `lstat`, so a symlink is neither `isFile()` nor
 * `isDirectory()` and is silently skipped, matching the same symlink
 * exclusion SidekickPackageLoader's own directory listing already applies
 * (no following a package's scripts/references out of its own tree).
 */
function listFilesRecursive(dir: string, baseDir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listFilesRecursive(abs, baseDir, out);
    } else if (entry.isFile()) {
      out.push(path.relative(baseDir, abs).split(path.sep).join('/'));
    }
  }
}

/**
 * Deterministic digest of a Sidekick package's ENTIRE tree (Issue #328
 * ninth-round review, finding 2) — not just SKILL.md's parsed body. A
 * package also ships `scripts/` (executable — e.g. pushing-default/scripts/
 * push.sh, which the rendered prompt tells the worker to run via
 * `{{sidekick.dir}}/scripts/*`) and `references/`; rewriting a script changes
 * what a run actually does without changing a single byte of the prompt
 * text, so hashing only `sidekick.body` (the old approach) left approval
 * blind to exactly the files a worker is instructed to execute.
 *
 * `body` is passed in (SidekickPackageLoader's already-parsed, mtime-cached
 * SKILL.md content) rather than re-read from `dir/SKILL.md` here — this is
 * the exact string `renderSidekickBody()` expands into the prompt, so this
 * digest tracks precisely what reaches the worker, and callers that already
 * hold a resolved `SidekickPackage` (every call site) don't pay a second
 * disk read for the one file guaranteed to already be in memory.
 * `scripts/**` and `references/**` have no equivalent in-memory copy — a
 * worker reads/executes those directly off disk via `{{sidekick.dir}}`, so
 * they're walked and read here.
 *
 * The relative path of each scripts/references file is folded into the
 * digest alongside its content, so a rename/add/remove changes the digest
 * even when every individual file's bytes are otherwise unchanged; paths are
 * read once via a single recursive listing and then sorted for a stable
 * iteration order (directory read order is not guaranteed stable across
 * platforms/calls). Reading twice for identical input must yield the same
 * digest (see ExecutionManifest.test.ts) — this function performs no
 * mutation and no randomness, only sorted reads.
 *
 * A missing target root (e.g. no `scripts/` directory) is not an error —
 * `listFilesRecursive` already tolerates a missing directory by returning no
 * entries for it, the same way a package with no scripts/references
 * legitimately has none.
 */
export function hashSidekickPackageTree(dir: string, body: string): string {
  const relPaths: string[] = [];
  for (const target of ['scripts', 'references']) {
    const targetPath = path.join(dir, target);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(targetPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      listFilesRecursive(targetPath, dir, relPaths);
    }
  }
  relPaths.sort();

  const hash = createHash('sha256');
  // NUL-delimited: not itself a security boundary (this hash isn't parsed
  // back apart), just enough to keep "a/b" + "c" from colliding with "a" +
  // "b/c" in the unlikely event two path/content pairs could otherwise
  // concatenate identically.
  hash.update('SKILL.md');
  hash.update('\0');
  hash.update(body);
  hash.update('\0');
  for (const relPath of relPaths) {
    let content: Buffer;
    try {
      content = fs.readFileSync(path.join(dir, relPath));
    } catch {
      content = Buffer.alloc(0);
    }
    hash.update(relPath);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Deterministic digest of a SET of project secret names (Issue #328
 * tenth-round review) — order-independent by construction: callers must
 * pass names already sorted (resolveExecutionManifest below does this), and
 * this function does not re-sort them itself so a caller mistake is visible
 * rather than silently masked. NUL-delimited between entries for the same
 * "no delimiter an attacker could use to make one name's suffix collide
 * with the next name's prefix" reason hashSidekickPackageTree's own doc
 * comment gives — secret names are project-admin-authored (not literally
 * attacker-controlled the way a task title is), but the same cheap
 * unambiguous encoding applies regardless.
 */
export function hashSecretNameSet(sortedNames: string[]): string {
  const hash = createHash('sha256');
  for (const name of sortedNames) {
    hash.update(name);
    hash.update('\0');
  }
  return hash.digest('hex');
}

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
    // Fields from the resolved `servers` row (via IServerRepository) that
    // decide WHICH MACHINE this task executes on — see the module doc
    // comment's `server` bullet above for why these were added (Issue #328
    // tenth-round review) and the "deliberately excluded" section for the
    // ServerConfig fields intentionally left out (agentToken, agentVersion,
    // sshHostFingerprint, muxRuntime, createdAt). `null` when `name` is null
    // (no resolvable server) or the named server row no longer exists.
    type: string | null;
    host: string | null;
    agentPort: number | null;
    sshHost: string | null;
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
  // See the module doc comment's `secrets.namesDigest` bullet above for what
  // this covers and why only names (sorted, digested), never values, are
  // included.
  secrets: {
    namesDigest: string;
  };
  /**
   * The resolved Sidekick package for every enabled phase from the resume
   * point onward, in order (see resolveCurrentPhaseIndex/
   * resolvePhaseSidekick and the module doc comment above — seventh-round
   * review). Empty when no Unit/UnitType/enabled phase can be resolved
   * (mirrors the `unit: null` tolerance elsewhere in this manifest);
   * `name`/`packageDigest` are null for a given entry when that phase
   * resolves but its package does not (misconfigured phaseConfig override,
   * no default package for the tag) — the real run's own
   * resolvePhaseSidekick() call still fails fast on that, this manifest only
   * needs to notice when it changes. `packageDigest` is a digest of the
   * package's ENTIRE tree (SKILL.md + scripts/** + references/**), not just
   * the parsed SKILL.md body — see hashSidekickPackageTree()'s doc comment
   * above for why (Issue #328 ninth-round review, finding 2: a worker can
   * execute `{{sidekick.dir}}/scripts/*`, so a script rewrite must invalidate
   * approval exactly like a SKILL.md rewrite does).
   */
  sidekicks: Array<{
    phase: string;
    name: string | null;
    packageDigest: string | null;
  }>;
  respawn: RespawnManifestInput | null;
}

/**
 * The subset of a persisted Window row's fields that decide what a respawn
 * actually launches (target server, worker model, per-pane worker types) —
 * see the `respawn` field's doc comment on ResolvedExecutionManifest above
 * and WindowRespawnService's module doc comment for why these can diverge
 * from what task/Unit resolution alone would produce. Built by
 * WindowRespawnService from the Window it is about to respawn (this module
 * must not import the `windows` module itself — see AGENTS.md's dependency
 * direction rule: `windows` depends on `tasks`, not the reverse).
 */
export interface RespawnManifestInput {
  serverName: string;
  workerModel: string | null;
  panes: Array<{ index: number; workerType: string | null }>;
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
  // Needed to resolve the `server.type`/`host`/`agentPort`/`sshHost` fields
  // (Issue #328 tenth-round review) — resolved via the SAME
  // `serverRepo.findByName(serverName)` call TransportFactory's callers use
  // at run time (ExecuteTaskUseCase.execute et al.), so this manifest can
  // never drift from what execution actually resolves the target machine to
  // be. A single resolution path here (not "pass in an already-resolved
  // ServerConfig sometimes, look it up internally other times") avoids the
  // exact class of drift the module doc comment above describes as how the
  // earlier holes opened up.
  serverRepo: IServerRepository;
  // Needed to resolve `secrets.namesDigest` (Issue #328 tenth-round review)
  // — `findByProject` (not `findByProjectWithValues`) so plaintext secret
  // values never reach this module, only names.
  projectSecretRepo: SqliteProjectSecretRepository;
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
 *
 * `respawnInput` is optional and only ever passed by WindowRespawnService —
 * every other call site omits it and gets `respawn: null` in the returned
 * manifest (see the `respawn` field's doc comment above).
 *
 * `serverNameOverride` (Issue #328 ninth-round review finding 3) is also
 * only ever passed by WindowRespawnService, and only when it differs from
 * what `resolveTaskServerName` alone would produce: a respawn always runs
 * against the Window's OWN server (`win.serverName`, which is also the
 * `server: ServerConfig` respawn()/resumeLegacySession() already resolved
 * before calling in — see WindowRespawnService.enforceExecutionGate's call
 * site), not the task's independently-resolved server (`task.serverName ??
 * the project's sole project_servers row`). The two can diverge — a task
 * resolved onto server A while its Window still lives on server B (this
 * class's own module doc comment explains how) — and without this override
 * both the `project_servers` row `checkExecutionGate` reads its input policy
 * from AND the `server` fields this manifest hashes would silently come
 * from the wrong server, letting server B's `deny` policy be bypassed by
 * server A's more permissive one. Every other call site (ExecuteTaskUseCase,
 * TaskRestoreService, the approve-execution handler for non-respawn
 * operations) omits it and keeps the task-resolved server, unchanged.
 */
export function resolveExecutionManifest(
  task: Task,
  deps: ExecutionManifestDeps,
  respawnInput?: RespawnManifestInput,
  serverNameOverride?: string,
): ExecutionManifestResolution {
  const project = deps.projectRepo.findById(task.projectId);
  const unitId = resolveUnitId(task, project);
  const unit = unitId !== null ? deps.unitRepo.findById(unitId) : null;
  const serverName = serverNameOverride ?? resolveTaskServerName(task, deps.projectServerRepo);
  const projectServer = serverName ? deps.projectServerRepo.find(task.projectId, serverName) : null;
  const baseBranch = resolveBaseBranch(task, projectServer, project);
  // Resolved via the same `serverRepo.findByName()` TransportFactory's
  // callers use at run time to pick local/SSH/agent — see the `server`
  // manifest field's doc comment above (Issue #328 tenth-round review).
  // `null` when there is no serverName to resolve, or the named row was
  // deleted after being registered — tolerated the same way a null
  // unit/projectServer is elsewhere in this function.
  const serverConfig = serverName ? deps.serverRepo.findByName(serverName) : null;

  // Sorted so the digest is independent of DB row insertion order — see
  // `secrets.namesDigest`'s doc comment above. `findByProject` (not
  // `findByProjectWithValues`): only names are read here, never values.
  const secretNames = deps.projectSecretRepo.findByProject(task.projectId).map((s) => s.name).sort();

  // Same resolution PhaseLoopRunner.stateMachineLoop uses to pick the phase
  // a run resumes at (resolveCurrentPhaseIndex), then resolvePhaseSidekick
  // for the package that renders it — both shared functions, not
  // reimplemented here, so this can never drift from what a real run
  // actually resolves (Issue #328 sixth-round review).
  const unitType = unit ? deps.unitTypeLoader.get(unit.unitType) : undefined;
  const sidekicks: ResolvedExecutionManifest['sidekicks'] = [];
  if (unit && unitType) {
    // EVERY enabled phase, unconditionally — not sliced from
    // task.currentPhase's resume point. task.currentPhase moves forward on
    // its own as an approved run progresses, so slicing from it made this
    // list (and therefore the fingerprint) change on every ordinary phase
    // transition, self-invalidating approval mid-run (eighth-round review;
    // see the module doc comment's "sidekicks" bullet).
    const enabledPhases = resolveEnabledPhases(unit.phaseConfig, unitType.phases);
    for (const phase of enabledPhases) {
      const phaseDef = unitType.phases.find((p) => p.name === phase);
      if (!phaseDef) {
        sidekicks.push({ phase, name: null, packageDigest: null });
        continue;
      }
      try {
        const sidekick = resolvePhaseSidekick(deps.sidekickLoader, phase, unit.phaseConfig, phaseDef);
        // Full package-tree walk (SKILL.md + scripts/** + references/**) is
        // only worth its I/O cost for an untrusted task — checkExecutionGate
        // allows every trusted task unconditionally, so a trusted resolution
        // (which every entry point still runs unconditionally today, e.g.
        // ExecuteTaskUseCase.enforceExecutionGate) never has its hash
        // compared against anything; the cheap body-only digest it already
        // used is enough for that discarded value (Issue #328 ninth-round
        // review: "trusted tasks pay nothing extra").
        const packageDigest = task.inputTrust === 'untrusted'
          ? hashSidekickPackageTree(sidekick.dir, sidekick.body)
          : createHash('sha256').update(sidekick.body).digest('hex');
        sidekicks.push({ phase, name: sidekick.name, packageDigest });
      } catch {
        // Misconfigured phaseConfig override / no default package for the
        // tag — tolerated here (see ResolvedExecutionManifest.sidekicks' doc
        // comment); the real run's own resolvePhaseSidekick() call still
        // fails fast on this.
        sidekicks.push({ phase, name: null, packageDigest: null });
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
      type: serverConfig?.type ?? null,
      host: serverConfig?.host ?? null,
      agentPort: serverConfig?.agentPort ?? null,
      sshHost: serverConfig?.sshHost ?? null,
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
    secrets: {
      namesDigest: hashSecretNameSet(secretNames),
    },
    sidekicks,
    respawn: respawnInput ?? null,
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
      type: manifest.server.type ?? '',
      host: manifest.server.host ?? '',
      // Left as `number | null` (not coerced to a sentinel number like 0,
      // unlike the string fields above coerced to '') — 0 is a value
      // `agentPort` could plausibly hold, so a real port and "unset" must
      // stay distinguishable in the hashed JSON.
      agentPort: manifest.server.agentPort ?? null,
      sshHost: manifest.server.sshHost ?? '',
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
    secrets: {
      namesDigest: manifest.secrets.namesDigest,
    },
    // Array order is significant and preserved by JSON.stringify — a
    // reordering of phases (via phaseConfig) changes this even if the same
    // set of packages is still assigned to the same set of phases.
    sidekicks: manifest.sidekicks.map((s) => ({
      phase: s.phase,
      name: s.name ?? '',
      packageDigest: s.packageDigest ?? '',
    })),
    // null for every call site except WindowRespawnService (see the
    // `respawn` field's doc comment on ResolvedExecutionManifest) — a
    // stable `null` here for non-respawn resolutions means this addition
    // does not change what any other call site hashes relative to omitting
    // the key entirely, aside from the one-time fingerprint rotation adding
    // any new key to this object always causes.
    respawn: manifest.respawn
      ? {
          serverName: manifest.respawn.serverName,
          workerModel: manifest.respawn.workerModel ?? '',
          panes: manifest.respawn.panes.map((p) => ({ index: p.index, workerType: p.workerType ?? '' })),
        }
      : null,
  });
  return createHash('sha256').update(normalized).digest('hex');
}
