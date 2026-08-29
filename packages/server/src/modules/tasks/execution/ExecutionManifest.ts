import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Task } from '../Task';
import type { IUnitRepository, SubagentConfig, Unit } from '../../units/Unit';
import type { IProjectRepository, ProjectDetail } from '../../projects/Project';
import type { IProjectServerRepository, ProjectServer } from '../../projects/ProjectServer';
import type { IServerRepository, ServerConfig } from '../../servers/Server';
import type { SqliteProjectSecretRepository } from '../../projects/SqliteProjectSecretRepository';
import type { PhaseConfig } from '../../sidekicks/PhaseConfig';
import type { SidekickPackageLoader } from '../../sidekicks/SidekickPackageLoader';
import type { UnitTypeLoader } from '../../sidekicks/UnitTypeLoader';
import { resolvePhaseSidekick, resolveEnabledPhases } from '../../sidekicks/resolvePhaseSidekick';
import { resolveUnitId, resolveTaskServerName, resolveBaseBranch, canonicalizeBaseBranch } from './TaskExecutionEnv';
import { resolveRecordedDistributionRepositoryEntry } from './DistributionHelper';

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
 * tasks/execution/ExecutionApprovalDecision.ts's approve-execution handler) resolves via this module
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
 *   list this file's own history describes above). Also, since the
 *   eleventh-round review: `skipPr` and `selfReviewMaxAttempts` (resolved,
 *   task override ?? Unit default — same precedence
 *   ExecuteTaskUseCase's `effectiveSelfReviewMax` uses). Both were previously
 *   in the "deliberately excluded" list on the mistaken assumption that they
 *   only select between fixed strings or control a loop count; in fact
 *   `skipPr` also selects the RENDERED CONTENT of `pushTaskDescription`/
 *   `pushRules`/`pushOutput` (resolveTaskPromptVars.ts) and whether
 *   PushVerifier requires a PR to exist (PhaseLoopRunner.ts ~375-385), and
 *   `selfReviewMaxAttempts` is interpolated into the prompt as
 *   `selfReview.maxAttempts` (PhaseLoopRunner.ts ~278-282) in addition to
 *   bounding the retry loop — both are prompt content, not just workflow
 *   shape.
 * - subagent: review/implement config, resolved the same way
 *   PhaseLoopRunner resolves it for an actual run (task override ??
 *   Unit default) — a task with no override still inherits the Unit's
 *   subagent config, so an edit to the UNIT's default must also be able to
 *   invalidate approval, not just a task-level override.
 * - project.sidekickPrompt: injected into every phase prompt by
 *   resolveTaskPromptVars.ts (`[project.sidekickPrompt, unit.systemPrompt]`) —
 *   editing it changes what the worker is told exactly like editing
 *   unit.systemPrompt does, so it must invalidate approval the same way.
 * - repository: identity (id/provider/url/owner/repoName) of the repository
 *   `resolveRecordedDistributionRepositoryEntry` resolves (DistributionHelper.ts
 *   — `task.distributionRepositoryId` once recorded, else
 *   `resolveExecutionRepositoryEntry`'s current-config resolution:
 *   `project.repositories[0]`, unless fetch distribution is active for this
 *   project/server, in which case the project-server's
 *   `distributionRepositoryId`) — the PR DESTINATION the pushing phase's
 *   PullRequestCreator/PushVerifier target (PhaseLoopRunner.ts ~367-384;
 *   Issue #328 twelfth-round review, fix 2; Issue #87 13th-round review,
 *   Important finding; Issue #87 review, forge/87-mirror follow-up,
 *   Important finding 1). Project repositories can be
 *   `POST`/`DELETE /api/projects/:id/repositories`, so without this field an
 *   already-approved task's PR could be silently redirected to a different
 *   repository post-approval — the same "changes WHERE output goes" class of
 *   targeting decision `server` above already covers for WHERE a task runs.
 *   `null` when the project has no registered repository (pushing then skips
 *   PR creation the same way it always has for a repository-less project),
 *   OR when `task.distributionRepositoryId` is recorded but no longer
 *   resolves (fails closed — never falls back to a possibly-different
 *   current-config repository).
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
 * - phases: since the eleventh-round review, the state-machine behavior
 *   flags PhaseLoopRunner reads off each enabled phase's UnitTypePhase
 *   definition — planApproval, questions, testFailed,
 *   testFailedRollbackTo, selfReviewRetry, pushVerify, subagentRole. Same
 *   enabled-phase list/order as `sidekicks` above. Before this round, only
 *   the phase NAME and its Sidekick package identity were covered — the
 *   UnitType TOML's own behavior flags could be edited freely post-approval
 *   with no fingerprint change, and `planApproval` in particular gates
 *   whether a human ever reviews the plan before an untrusted task's
 *   implementation runs: removing it from an already-approved task's
 *   UnitType silently deleted that checkpoint. See the field's own doc
 *   comment on ResolvedExecutionManifest for exactly which flags and why
 *   each is/isn't included.
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
 *   and the system does not overwrite mid-run for this purpose. This was
 *   previously an aspiration rather than a fact (Issue #328 review round):
 *   ExecuteTaskUseCase.execute's worktree-creation write, its post-run git-
 *   info tail, and PhaseLoopRunner's end-of-run git-info write all wrote the
 *   resolved worktree branch back into `task.branch` too — so approving an
 *   untrusted task with no client-specified branch, then running it,
 *   self-invalidated the very approval the run was operating under the
 *   moment the worktree was created (the fingerprint hashed `branches.work`
 *   before the run started, the run then changed the value that field
 *   hashes, and the next phase-boundary reverification saw a mismatch and
 *   threw the task back to `pending_approval` with a tmux window and
 *   worktree already created). All three writes now target `worktreeBranch`
 *   instead — see each call site's own comment.
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
 *
 * ── Scope of this manifest (Issue #328 eleventh-round review) ──
 *
 * Eleven review rounds have each found one more field this manifest was
 * missing. This section exists to stop that from being an open-ended
 * search: it states the RULE the current field list already follows, so the
 * next addition (or non-addition) can be justified against the rule instead
 * of against "well, review round N found this one too".
 *
 * What belongs in this manifest: any value that (a) can be changed through
 * an API or a user-layer file (not just by the system itself), AND (b)
 * changing it changes WHAT gets executed, WHERE it executes, or HOW the
 * state machine behaves — prompt content, worker target, subagent
 * delegation, or control flow (approval gates, retry/rollback, phase
 * enable/order). If a human approved a task under one set of these values,
 * a later edit to any of them must force re-approval.
 *
 * Currently covered, by category:
 * - task: title, description, workingDirectory, skipPr, selfReviewMaxAttempts
 *   (resolved).
 * - unit: id, systemPrompt, workerType/Model/ExtraArgs, workerExecutionMode,
 *   workerRuntime, unitType, phaseConfig.
 * - UnitType phases (per enabled phase, in order): planApproval, questions,
 *   testFailed, testFailedRollbackTo, selfReviewRetry, pushVerify,
 *   subagentRole (the `phases` field), plus the resolved Sidekick package
 *   identity/content for that phase (the `sidekicks` field).
 * - Sidekick packages: a full package-tree digest (SKILL.md body +
 *   scripts/** + references/**) per enabled phase.
 * - project: sidekickPrompt.
 * - project_servers: workingDirectory, branch.
 * - ServerConfig (the `servers` row): type, host, agentPort, sshHost — which
 *   machine a run targets.
 * - repository: id, provider, url, owner, repoName of the repository
 *   `resolveRecordedDistributionRepositoryEntry` resolves — which repository
 *   the pushing phase's PR targets (Issue #328 twelfth-round review, fix 2;
 *   Issue #87 13th-round review, Important finding; Issue #87 review,
 *   forge/87-mirror follow-up, Important finding 1).
 * - secrets: the SORTED SET of project secret NAMES (not values — see
 *   "known limitations" below).
 *
 * Digest computation itself is part of this manifest's trusted computing
 * base, not a best-effort convenience (Issue #328 twelfth-round review,
 * fix 1): `hashSidekickPackageTree()` reads an untrusted task's ENTIRE
 * resolved Sidekick package tree (SKILL.md + scripts/** + references/**)
 * off disk to compute the digest this manifest hashes. A filesystem error
 * while doing that — permission denied, an I/O error, a file that vanished
 * mid-walk — is NOT treated as "empty"/"no content" and does not produce a
 * digest for a partially-read tree. It is thrown, and propagates out of
 * `resolveExecutionManifest()` through whichever `checkExecutionGate()` call
 * site invoked it (ExecuteTaskUseCase.enforceExecutionGate,
 * TaskRestoreService.restore, WindowRespawnService.enforceExecutionGate,
 * PhaseLoopRunner.reverifyExecutionGateForPhase, the approve-execution
 * handler in units/routes.ts). Every one of those either lets the exception
 * propagate to its own caller (which marks the task `failed` on rejection —
 * see ExecuteTaskUseCase.execute's `runLoop.catch()`) or returns an HTTP
 * 500 (the approve-execution handler has no catch around its
 * `resolveExecutionManifest()` call) — none of them convert this into an
 * allowed run or a recorded approval. The only filesystem error this
 * digest computation tolerates is `ENOENT` on an OPTIONAL `scripts/`/
 * `references/` root itself (a package legitimately having neither); every
 * other error, at any depth, is fail-closed: approval and execution both
 * stop rather than proceed against an incompletely-read package.
 *
 * Deliberately NOT covered, and why — three recurring shapes, not a field-by-
 * field list (see the "Deliberately excluded" section above for the current
 * field-by-field detail):
 * 1. Values the SYSTEM overwrites as a side effect of running an
 *    already-approved task (worktreePath/worktreeBranch, tmuxWindow,
 *    agentSessionId, task.currentPhase, status, selfReviewCount,
 *    planMarkdown, changedFiles, prUrl, summaryJson, server.agentVersion,
 *    server.sshHostFingerprint). Including any of these makes "approve once"
 *    into an infinite pending_approval loop, because the very act of running
 *    the approved task changes the value and re-triggers the gate. This is
 *    the single most common way a new field breaks this file (it happened
 *    twice already — sixth-round and eighth-round reviews) — always ask
 *    "does an ordinary, already-approved run change this on its own?"
 *    before adding a field.
 * 2. Credentials, where the correct operational response to a leak/rotation
 *    is "replace the value, change nothing else" (server.agentToken, and by
 *    the same logic, secret VALUES — see "known limitations" below).
 *    Covering these would make routine credential rotation invalidate every
 *    already-approved task that depends on them, discouraging rotation.
 * 3. Operational/administrative state managed independently of the approval
 *    decision (server.muxRuntime, server.createdAt, requirePlanApproval —
 *    can only be strengthened for an untrusted task, source/sourceRef — not
 *    read by any prompt-building/targeting path).
 *
 * Known limitations (things this manifest does NOT currently protect
 * against, stated plainly rather than implied by omission):
 * - Secret VALUE rotation is invisible to this manifest by design (see
 *   `secrets.namesDigest`'s own doc comment) — replacing an already-approved
 *   secret's value with different content does not require re-approval, only
 *   adding/removing/renaming a secret does.
 * - A Unit or UnitType field this manifest does not read (because
 *   PhaseLoopRunner/ExecuteTaskUseCase does not read it either, as of this
 *   round) is not covered — this file only tracks inputs to the CURRENT
 *   execution path; a future code change that starts consuming a
 *   previously-inert field must add it here in the same change, not rely on
 *   a future review round to notice.
 * - This manifest hashes the RESOLVED values, not "what a human read in the
 *   approval UI" — if the approval UI itself renders a resolved value
 *   incorrectly, re-approval will still succeed against the (correctly)
 *   resolved manifest even though the human saw something else. That's a UI
 *   correctness concern, outside this file's scope.
 * - On ssh/agent (remote) servers, this manifest's `sidekicks[i].packageDigest`
 *   is a digest of the HUB's own local Sidekick package tree ONLY (Issue #328
 *   thirteenth-round review, confirmed against the actual sync
 *   implementation — see SidekickSyncService.ts). What a remote worker
 *   actually reads and executes from `{{sidekick.dir}}` is a SEPARATE, synced
 *   copy under `~/.azito/sidekicks/<name>` on that server, not the hub's
 *   local tree this digest was computed from. `PhaseLoopRunner.
 *   ensureSidekicksSynced()` pushes that copy exactly ONCE, before the
 *   `while` loop over phases starts (`stateMachineLoop`, before
 *   `currentPhaseIndex` begins iterating) — not re-verified at every phase
 *   boundary the way the execution gate itself is
 *   (`reverifyExecutionGateForPhase`, called inside the loop on every
 *   iteration). And the sync is skip-if-unchanged: it trusts a hash MARKER
 *   file it wrote on the remote (`~/.azito/sidekicks/.azito-sidekicks-hash`),
 *   not a re-read of the remote tree's actual content — so if something with
 *   write access to that path on the remote machine (which very plausibly
 *   includes the task's own worker process, since it runs on that same
 *   machine) rewrites a script under `~/.azito/sidekicks/<name>/scripts/`
 *   directly, without touching the marker file, this manifest's digest does
 *   not change (it never read the remote copy to begin with), the gate never
 *   throws, and every remaining phase in that run executes the rewritten
 *   script. In short: **this manifest guarantees the approved content matches
 *   what's on the HUB's local disk; on a remote server it does NOT guarantee
 *   that content is what actually executes.** Closing this would require
 *   either re-verifying the remote tree's actual content against the digest
 *   at every phase boundary (remote I/O added to the gate-check path itself,
 *   a materially larger change than this round's scope) or placing packages
 *   at a content-addressed remote path (e.g. keyed by this same digest, so a
 *   stale/tampered copy can never satisfy a phase that requires a different
 *   digest) — neither is implemented as of this round.
 * - **The gate check is a single point-in-time inspection before dispatch,
 *   not a lease held for the duration of dispatch.** `checkExecutionGate`
 *   (and the fingerprint check in `decideExecutionApproval`) evaluate this
 *   manifest ONCE, synchronously, immediately before an operation is
 *   allowed to proceed. Everything after that point — tmux window creation
 *   (including secret injection into the pane environment), worktree
 *   creation, and the worker launch itself — runs across multiple `await`
 *   boundaries (`resourceGuard.check`, containment/path verification, tmux
 *   calls) that this single check does not span. If the task, its Unit, its
 *   Sidekick packages, the target server, the applicable input policy, or
 *   the project's secrets are modified while one of those awaits is in
 *   flight, dispatch continues to completion under the approval that was
 *   valid at the moment the gate was checked — not under whatever changed a
 *   moment later. The per-phase re-verification
 *   (`reverifyExecutionGateForPhase`, referenced above) only runs AFTER the
 *   worker has already been launched for the current phase, so it cannot
 *   close this window; it protects against drift between phases, not drift
 *   between "gate passed" and "worker actually started". `followUp()` has
 *   the same shape (gate check, then the same multi-await dispatch path).
 *   Fully closing this would require either a lock that prevents the
 *   approved inputs from being edited while dispatch for that task is in
 *   progress, or an execution lease that re-verifies at every
 *   side-effecting step rather than once up front — **neither is
 *   implemented as of this round**; this file provides a single up-front
 *   gate check only, which is Issue #27's scope.
 */

/**
 * Recursively collects every regular file under `dir`, returning paths
 * relative to `dir` with forward slashes (platform-independent, deterministic
 * comparison).
 *
 * Symlinks are fail-closed, not silently skipped (Issue #328 thirteenth-round
 * review). An earlier version of this function treated a symlink exactly
 * like SidekickPackageLoader's own directory listing does — `fs.Dirent`
 * entries from `withFileTypes: true` use `lstat`, so a symlink is neither
 * `isFile()` nor `isDirectory()` and was silently excluded from the walk.
 * That's the right call for SidekickPackageLoader (it's choosing what a
 * builtin/user package LISTING shows), but wrong here: a worker executing a
 * rendered Sidekick prompt can follow a symlink under `{{sidekick.dir}}/
 * scripts` and run whatever it points to, so silently excluding it from the
 * digest meant an attacker could swap the symlink's target (or the symlink
 * itself) after approval and change what actually runs without changing the
 * hash a human approved. Resolving the target and hashing ITS content would
 * fix that, but only if the target is also verified to stay inside the
 * package root — a symlink can point anywhere on disk (`../../etc/passwd`,
 * an absolute path, another package's tree) — and that containment check is
 * out of scope for a manifest that only needs to detect drift, not sandbox
 * an arbitrary filesystem read. So a symlink anywhere under `scripts/` or
 * `references/` throws instead: fail closed, matching every other
 * unreadable-tree case this function's caller already fails closed on (see
 * `hashSidekickPackageTree`'s doc comment). None of the six builtin Sidekick
 * packages (`harness/sidekicks/`) contain a symlink, so this does not break
 * existing usage — see ExecutionManifest.test.ts for the regression test.
 *
 * `readdirSync` errors are NOT caught here (Issue #328 twelfth-round
 * review — this function used to treat any `readdirSync` failure, including
 * a permission error or other I/O error, as "empty directory", which let a
 * package this manifest could not fully read get hashed as if the unreadable
 * portion did not exist. `dir` here is always either the already-`statSync`-
 * verified `scripts`/`references` root (see `hashSidekickPackageTree`, which
 * tolerates only that root's own `ENOENT`) or a subdirectory this same
 * function just discovered via a successful `readdirSync` one level up — so
 * by the time this call is made, `dir` is known to exist; any failure to
 * read it now is an unexpected error (permissions, I/O, or a race where it
 * was removed mid-walk) and must propagate to the caller of
 * `hashSidekickPackageTree`, not be silently treated as "no files here".
 */
function listFilesRecursive(dir: string, baseDir: string, out: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const relPath = path.relative(baseDir, abs).split(path.sep).join('/');
      throw new Error(
        `Sidekick package tree contains a symlink at "${relPath}" — refusing to compute a digest ` +
          `(symlink targets are not verified to stay inside the package root; approval must fail closed).`,
      );
    } else if (entry.isDirectory()) {
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
 * A missing target root (e.g. no `scripts/` directory) is not an error — a
 * package with no scripts/references legitimately has none. That is the
 * ONLY filesystem failure this function tolerates, and only as an `ENOENT`
 * on the root itself (Issue #328 twelfth-round review): any other
 * `statSync`/`readdirSync`/`readFileSync` failure — permission denied, an
 * I/O error, or a file that vanished between being listed and being read —
 * is a sign this function could NOT actually read the full package tree,
 * and is thrown rather than silently treated as "empty"/"no content". This
 * is security-critical: `hashSidekickPackageTree`'s result is what an
 * untrusted task's approval is recorded against and what `checkExecutionGate`
 * compares on every phase transition (see `resolveExecutionManifest` below,
 * and its callers' fail-fast requirement documented in the module doc
 * comment's "Scope of this manifest" section) — a digest computed from a
 * PARTIAL read is worse than no digest at all, because it lets an attacker
 * who can make part of the tree unreadable get a hash that has nothing to
 * do with the tree's actual (unreadable) content approved or waved through
 * an already-approved gate check. Every call site's failure mode when this
 * throws is: the gate check itself throws, execution does not proceed, and
 * the task ends up `failed` (verified for every `resolveExecutionManifest`
 * caller — see the module doc comment).
 */
export function hashSidekickPackageTree(dir: string, body: string): string {
  const relPaths: string[] = [];
  for (const target of ['scripts', 'references']) {
    const targetPath = path.join(dir, target);
    let stat: fs.Stats;
    try {
      // lstatSync, not statSync (Issue #328 review): statSync follows a
      // symlink before returning, so if `scripts`/`references` ITSELF were a
      // symlink, the isDirectory() check below would happily walk whatever
      // the link points to — the same "fail closed on symlinks" contract
      // listFilesRecursive already enforces for nested entries, just missing
      // at the root. lstatSync reports the link itself, so the isSymbolicLink()
      // check right below can reject it before any traversal begins.
      stat = fs.lstatSync(targetPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Sidekick package tree root "${target}" is a symlink — refusing to compute a digest ` +
          `(symlink targets are not verified to stay inside the package root; approval must fail closed).`,
      );
    }
    if (!stat.isDirectory()) {
      // Neither ENOENT (tolerated above) nor a real directory nor a symlink
      // (rejected above) — an unexpected entry type (e.g. a regular file
      // named `scripts`). Fail closed rather than silently treat it as "no
      // scripts" the way the old statSync-based check did.
      throw new Error(
        `Sidekick package tree root "${target}" is not a directory — refusing to compute a digest.`,
      );
    }
    listFilesRecursive(targetPath, dir, relPaths);
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
    // No try/catch: a file listed a moment ago that now fails to read
    // (permissions, I/O error, or removed mid-walk) must fail this digest
    // computation, not silently contribute empty content — see this
    // function's own doc comment above.
    const content = fs.readFileSync(path.join(dir, relPath));
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
    // Issue #29 review, Critical finding 2: whether the resolved target
    // server is declared isolation_intent=1 — TaskPaneEnvironmentService
    // withholds ALL project secrets (and, once scoped auth is fully rolled
    // out, the hub UI/agent tokens) from such a server (see its module doc
    // comment). Before this field existed, toggling isolation_intent on/off
    // for an ALREADY-approved task's server changed nothing this fingerprint
    // covered: approving a task while unisolated, then flipping the server to
    // isolated (or the reverse — flipping OFF an isolated server post-
    // approval, silently exposing every project secret to a task a human
    // approved under the belief no secret would ever reach it) left the
    // fingerprint unchanged, so the execution gate never re-prompted for
    // approval. `secrets.namesDigest` below is derived from the set of
    // secrets ACTUALLY injected (empty when isolated), so the two fields
    // together make both directions of that toggle visible to the gate.
    isolationIntent: boolean;
    // Issue #87 13th-round review, Important finding 2: the project_servers
    // row's own `distribute_code` opt-in — whether ExecuteTaskUseCase (and,
    // since this same review round, TaskRestoreService) fetches code from
    // the hub's own git credentials onto this server before the task runs
    // (see DistributionHelper.ts's `isDistributionRequired`). An operator
    // approving a manifest with this off is approving "this task runs
    // against whatever is already on the target machine" — turning it on
    // afterwards, without invalidating that approval, would let an
    // already-approved untrusted-input task start pulling hub-credentialed
    // code onto the server the very next run, which is a materially
    // different trust boundary than what was approved. `false` when
    // `projectServer` itself is null (no resolvable project_servers row).
    distributeCode: boolean;
    // Issue #87 explicit-target follow-up: which repository distribution
    // pulls onto this server (see `ProjectServer.distributionRepositoryId`'s
    // doc comment and `DistributionHelper.ts`'s module doc comment for why
    // this is never inferred). Same trust-boundary reasoning as
    // `distributeCode` above: an already-approved manifest's distribution
    // SOURCE changing (e.g. an operator repoints this project server at a
    // different repository — a different set of git credentials, a
    // different codebase) is exactly as material a change as flipping
    // `distributeCode` itself, and must invalidate the same way. `null`
    // when `projectServer` itself is null or has no target configured.
    distributionRepositoryId: number | null;
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
    // See the module doc comment's "task" bullet (eleventh-round review) for
    // why these two were added — both were previously excluded on the
    // mistaken assumption that they only select between fixed strings /
    // control a loop count, when in fact both also change rendered prompt
    // content.
    skipPr: boolean;
    // Resolved the same way PhaseLoopRunner computes `effectiveSelfReviewMax`
    // (task.selfReviewMaxAttempts ?? unit.selfReviewMaxAttempts) — `null` only
    // when neither a task override nor a resolvable Unit exists.
    selfReviewMaxAttempts: number | null;
  };
  subagent: {
    review: SubagentConfig | null;
    implement: SubagentConfig | null;
  };
  project: {
    sidekickPrompt: string | null;
  };
  /**
   * Identity of the repository the pushing phase will target — `id`,
   * `provider`, `url`, `owner`, `repoName` of the repository
   * `resolveRecordedDistributionRepositoryEntry` resolves (Issue #328
   * twelfth-round review, fix 2; Issue #87 13th-round review, Important
   * finding; Issue #87 review, forge/87-mirror follow-up, Important finding
   * 1 — treats `task.distributionRepositoryId` as authoritative once
   * recorded, falling back to `resolveExecutionRepositoryEntry`'s
   * current-config resolution only for a task that has never gone through
   * distribution). Resolved via the exact same selection PhaseLoopRunner's
   * pushing-phase probe/notary and ExecuteTaskUseCase's push-completion
   * paths use — not a second, separately-written selection rule; see this
   * file's own `resolveExecutionManifest` for why a second resolution path
   * is exactly how earlier review rounds' holes opened up. `null` when the
   * project has no registered repository, no resolvable project at all
   * (mirrors the `unit: null` tolerance elsewhere in this manifest), or the
   * recorded `distributionRepositoryId` no longer resolves (fails closed —
   * never falls back to current config). `token` is deliberately never read
   * here (`findRepositoryById` is not called) — same "credential rotation
   * must not self-invalidate approval" reasoning as `server.agentToken` in
   * the "deliberately excluded" section above; a repository's URL/owner/name
   * is a targeting decision a human reviews, its access token is not.
   */
  repository: {
    id: number;
    provider: string;
    url: string;
    owner: string | null;
    repoName: string | null;
    tokenDigest: string;
  } | null;
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
  /**
   * The state-machine behavior flags PhaseLoopRunner actually reads off each
   * enabled phase's `UnitTypePhase` definition (Issue #328 eleventh-round
   * review) — every field consumed by `stateMachineLoop` below:
   * `planApproval` (PhaseLoopRunner.ts ~455, gates on human plan review —
   * the single most important flag here, see the module doc comment),
   * `questions`/`testFailed` (~327, the worker capability envelope),
   * `testFailedRollbackTo` (~475-482, which phase a test failure rewinds
   * to), `selfReviewRetry` (~488-494, whether a non-`phase_complete`
   * classification retries the phase), `pushVerify` (~358-387, whether push
   * completion is probed before the phase is considered done), and
   * `subagentRole` (~284-313, whether/which subagent-delegation block is
   * appended to the prompt). Same enabled-phase list and order as
   * `sidekicks` above (resolveEnabledPhases), so a phase reorder/enable/
   * disable is visible on both arrays consistently.
   *
   * Deliberately NOT included: `label` (display-only), `tags` (already
   * reflected indirectly — a tag change can only affect which package an
   * override resolves to, and that resolution's OUTCOME is already captured
   * by `sidekicks[i].name`/`packageDigest` above), `skillCommand`/
   * `defaultSidekick` (read by the `/api/sidekicks`-render / harness-skill
   * compat path, not by PhaseLoopRunner), and `name` (redundant with
   * `phase` on this same entry).
   */
  phases: Array<{
    phase: string;
    planApproval: boolean;
    questions: boolean;
    testFailed: boolean;
    testFailedRollbackTo: string | null;
    selfReviewRetry: boolean;
    pushVerify: boolean;
    subagentRole: string | null;
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
  /**
   * The full resolved `servers` row for `serverName` (Issue #29 Step 3a), or
   * `null` under the same conditions `manifest.server.isolationIntent`
   * already tolerates (no resolvable `serverName`, or the row was deleted
   * after being registered). Exists alongside `manifest.server` (which only
   * carries the fields the approval fingerprint hashes) because
   * `resolveEffectiveInputPolicy` (projects/ProjectServer.ts) additionally
   * needs `isolationVerifiedAt` — deliberately NOT part of the manifest/
   * fingerprint (a doctor re-verification must not self-invalidate an
   * already-approved manual-approval task; see the manifest's own "server"
   * field doc comment for the excluded-fields rationale). Every
   * `checkExecutionGate` call site resolves the effective policy from THIS
   * field, not by re-querying `serverRepo` a second time.
   */
  serverConfig: ServerConfig | null;
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
  // Canonicalized the same way, and at the same point in the resolution
  // chain, as ExecuteTaskUseCase.execute() (see `canonicalizeBaseBranch`'s
  // doc comment in TaskExecutionEnv.ts) — otherwise a pre-existing task
  // whose resolved base branch is `origin/main` or `refs/heads/main` would
  // have its APPROVED/fingerprinted manifest record that raw value while
  // execution actually normalizes and runs against `main`, silently
  // breaking the execution gate's "what was approved is what runs"
  // guarantee (Issue #87 third-party review, 12th round, Important finding
  // 3). Every manifest consumer (approval, restore's own gate check,
  // respawn) resolves through this one function, so applying it here is
  // sufficient — no other resolveBaseBranch() call site feeds a manifest.
  const baseBranch = canonicalizeBaseBranch(resolveBaseBranch(task, projectServer, project));
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
  //
  // Issue #29 review, Critical finding 2: derived from the set ACTUALLY
  // injected, not merely "every secret the project has" — TaskPaneEnvironmentService
  // withholds every AZITO_SECRET_* entirely for an isolation_intent=1 server
  // (skipped before decrypt, see its own doc comment), so the fingerprint
  // must reflect an empty set for such a server. Without this, an
  // already-approved task's fingerprint would not change when its server is
  // (de)isolated post-approval, even though the set of secrets actually
  // reaching the pane changes from "every project secret" to "none" or back.
  const secretNames = serverConfig?.isolationIntent
    ? []
    : deps.projectSecretRepo.findByProject(task.projectId).map((s) => s.name).sort();

  // Same resolution PhaseLoopRunner.stateMachineLoop uses to pick the phase
  // a run resumes at (resolveCurrentPhaseIndex), then resolvePhaseSidekick
  // for the package that renders it — both shared functions, not
  // reimplemented here, so this can never drift from what a real run
  // actually resolves (Issue #328 sixth-round review).
  const unitType = unit ? deps.unitTypeLoader.get(unit.unitType) : undefined;
  const sidekicks: ResolvedExecutionManifest['sidekicks'] = [];
  const phases: ResolvedExecutionManifest['phases'] = [];
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
      // The state-machine behavior flags this phase carries — see the
      // `phases` field's doc comment on ResolvedExecutionManifest above for
      // exactly which PhaseLoopRunner reads and why (Issue #328
      // eleventh-round review).
      phases.push({
        phase,
        planApproval: phaseDef.planApproval,
        questions: phaseDef.questions,
        testFailed: phaseDef.testFailed,
        testFailedRollbackTo: phaseDef.testFailedRollbackTo ?? null,
        selfReviewRetry: phaseDef.selfReviewRetry,
        pushVerify: phaseDef.pushVerify,
        subagentRole: phaseDef.subagentRole ?? null,
      });
      let sidekick;
      try {
        sidekick = resolvePhaseSidekick(deps.sidekickLoader, phase, unit.phaseConfig, phaseDef);
      } catch {
        // Misconfigured phaseConfig override / no default package for the
        // tag — tolerated here (see ResolvedExecutionManifest.sidekicks' doc
        // comment); the real run's own resolvePhaseSidekick() call still
        // fails fast on this.
        sidekicks.push({ phase, name: null, packageDigest: null });
        continue;
      }
      // Deliberately OUTSIDE the try/catch above (Issue #328 twelfth-round
      // review): that catch exists only to tolerate "no package resolves for
      // this phase", not to swallow a filesystem failure while digesting a
      // package that DID resolve. hashSidekickPackageTree() only tolerates a
      // missing optional scripts/references directory internally — every
      // other fs error (permission denied, I/O error, a file vanishing
      // mid-walk) is thrown by it and must propagate all the way out of
      // resolveExecutionManifest to whichever checkExecutionGate call site is
      // resolving this manifest, so an unreadable package tree stops
      // execution/approval instead of being hashed as if it were empty.
      const packageDigest = task.inputTrust === 'untrusted'
        // Full package-tree walk (SKILL.md + scripts/** + references/**) is
        // only worth its I/O cost for an untrusted task — checkExecutionGate
        // allows every trusted task unconditionally, so a trusted resolution
        // (which every entry point still runs unconditionally today, e.g.
        // ExecuteTaskUseCase.enforceExecutionGate) never has its hash
        // compared against anything; the cheap body-only digest it already
        // used is enough for that discarded value (Issue #328 ninth-round
        // review: "trusted tasks pay nothing extra").
        ? hashSidekickPackageTree(sidekick.dir, sidekick.body)
        : createHash('sha256').update(sidekick.body).digest('hex');
      sidekicks.push({ phase, name: sidekick.name, packageDigest });
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
      isolationIntent: serverConfig?.isolationIntent ?? false,
      // Issue #87 13th-round review, Important finding 2: see the field's
      // own doc comment on ResolvedExecutionManifest.server above.
      distributeCode: projectServer?.distributeCode ?? false,
      // Issue #87 explicit-target follow-up: see the field's own doc
      // comment on ResolvedExecutionManifest.server above.
      distributionRepositoryId: projectServer?.distributionRepositoryId ?? null,
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
      skipPr: task.skipPr,
      // Same precedence PhaseLoopRunner's callers resolve
      // (ExecuteTaskUseCase's `effectiveSelfReviewMax`) — task override,
      // falling back to the resolved Unit's default.
      selfReviewMaxAttempts: task.selfReviewMaxAttempts ?? unit?.selfReviewMaxAttempts ?? null,
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
    // Issue #87 review (forge/87-mirror follow-up), Important finding 1:
    // must agree with `ExecuteTaskUseCase.resumeStateMachine()`/`followUp()`/
    // `isPushCompleted()`, which all treat `task.distributionRepositoryId`
    // (once recorded) as authoritative and NEVER re-resolve from the
    // project/project-server's CURRENT configuration — see
    // `resolveRecordedDistributionRepositoryEntry`'s doc comment
    // (DistributionHelper.ts). Before this fix, the approval manifest always
    // called `resolveExecutionRepositoryEntry` (current config only), so a
    // config change after a task's first distribution could make the
    // approval UI / fingerprint show a DIFFERENT repository than the one
    // `resumeStateMachine()` actually runs against — breaking the "what was
    // approved is what runs" guarantee this manifest exists to uphold. A
    // task with no recorded value yet (first execution, never distributed)
    // still resolves from current config, same as every other manifest
    // field. `ok: false` (the recorded repository was deleted) fails
    // closed to `null` here — same as `resolveExecutionRepositoryEntry`'s
    // own "required but unresolved never falls back" rule — rather than
    // falling back to whatever current config would resolve.
    repository: (() => {
      const resolution = resolveRecordedDistributionRepositoryEntry(task.distributionRepositoryId ?? null, serverConfig, projectServer, project);
      const repo = resolution.ok ? resolution.entry : null;
      if (!repo) return null;
      const repoWithToken = deps.projectRepo.findRepositoryById(repo.id);
      const tokenDigest = repoWithToken?.token
        ? createHash('sha256').update(repoWithToken.token).digest('hex')
        : 'no_token';
      return { id: repo.id, provider: repo.provider, url: repo.url, owner: repo.owner, repoName: repo.repoName, tokenDigest };
    })(),
    secrets: {
      namesDigest: hashSecretNameSet(secretNames),
    },
    sidekicks,
    phases,
    respawn: respawnInput ?? null,
  };

  return { manifest, project, unit, serverName, projectServer, serverConfig };
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
      // Issue #29 review, Critical finding 2: see the field's own doc
      // comment on ResolvedExecutionManifest.server above.
      isolationIntent: manifest.server.isolationIntent,
      // Issue #87 13th-round review, Important finding 2: see the field's
      // own doc comment on ResolvedExecutionManifest.server above.
      distributeCode: manifest.server.distributeCode,
      // Issue #87 explicit-target follow-up: see the field's own doc
      // comment on ResolvedExecutionManifest.server above.
      distributionRepositoryId: manifest.server.distributionRepositoryId,
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
      skipPr: manifest.task.skipPr,
      // Left as `number | null` (not coerced to a sentinel), same reasoning
      // as `server.agentPort` above — a real attempt count and "unresolved"
      // must stay distinguishable.
      selfReviewMaxAttempts: manifest.task.selfReviewMaxAttempts ?? null,
    },
    subagent: {
      review: normalizeSubagent(manifest.subagent.review),
      implement: normalizeSubagent(manifest.subagent.implement),
    },
    project: {
      sidekickPrompt: manifest.project.sidekickPrompt ?? '',
    },
    repository: manifest.repository
      ? {
          id: manifest.repository.id,
          provider: manifest.repository.provider,
          url: manifest.repository.url,
          owner: manifest.repository.owner ?? '',
          repoName: manifest.repository.repoName ?? '',
          tokenDigest: manifest.repository.tokenDigest,
        }
      : null,
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
    // Array order is significant and preserved by JSON.stringify — same
    // reasoning as `sidekicks` above (a phase reorder must change this).
    phases: manifest.phases.map((p) => ({
      phase: p.phase,
      planApproval: p.planApproval,
      questions: p.questions,
      testFailed: p.testFailed,
      testFailedRollbackTo: p.testFailedRollbackTo ?? '',
      selfReviewRetry: p.selfReviewRetry,
      pushVerify: p.pushVerify,
      subagentRole: p.subagentRole ?? '',
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
