import type { ServerConfig } from '../../servers/Server';
import type { Task } from '../Task';
import type { ITaskTokenRepository } from '../tokens/TaskToken';
import type { SqliteProjectSecretRepository } from '../../projects/SqliteProjectSecretRepository';
import type { AuditLogService } from '../../../shared/audit/AuditLogService';
import { recordAuditBestEffort } from '../../../shared/audit/recordAuditBestEffort';
import { ISOLATION_MASKED_ENV } from '../../../shared/auth/isolationMaskedEnv';

/**
 * Single builder for the env a task's tmux pane launches with (Issue #28
 * design v3 §6, Phase A後半) — the one thing execute()/followUp()
 * (ExecuteTaskUseCase), TaskRestoreService.restore(), and
 * WindowRespawnService.respawn()/resumeLegacySession() all need identically
 * and, before this class existed, each rebuilt slightly differently (or, for
 * restore()/respawn(), didn't build at all — see the module doc comment on
 * WindowRespawnService for the class of bug that gap caused). Callers pass
 * the returned Record straight to `TmuxClient.createWindow`'s `extraEnv`
 * option.
 *
 * ONLY call {@link buildEnvForNewWindow} from a code path that is actually
 * (re)creating the task's tmux window — never for a resume onto an existing,
 * already-running window (design v3 §2: "既存ウィンドウ再利用のresumeでは
 * ローテートしない"). tmux env can only be set at window-creation time, so a
 * resume onto an existing window has nowhere to deliver a rotated token
 * anyway; those call sites (e.g. ExecuteTaskUseCase.followUp when the window
 * already exists) simply don't call this at all.
 *
 * ALSO only call {@link buildEnvForNewWindow} for the task's PRIMARY worker
 * window (Issue #28 third-party review finding — multi-window token rotation
 * collision): the token generation this issues is bound one-to-one to the
 * primary window (`task.tmuxWindow`), and `issueNextGeneration` revokes every
 * other outstanding generation for the task as part of rotating — calling
 * this for a secondary window (added via `POST /api/tasks/:id/windows`)
 * would invalidate the still-live primary pane's token. A secondary window's
 * (re)creation must use {@link buildEnvForSecondaryWindow} instead; see
 * `isPrimaryTaskWindow` (windows/Window.ts) for the shared judgment every
 * call site uses to tell the two apart.
 */
/**
 * Applies the AZITO_UI_TOKEN/AZITO_AGENT_TOKEN(+PORT) injection-or-mask
 * decision shared by {@link TaskPaneEnvironmentService.buildEnvForNewWindow}
 * and {@link TaskPaneEnvironmentService.buildEnvForSecondaryWindow} — kept as
 * one function so the two call sites can never drift on this decision (Issue
 * #29 review, Critical finding 1).
 *
 * isolation_intent is checked FIRST, before the scoped-auth compat-mode
 * branch, and wins unconditionally: a server declared isolation_intent=1 is
 * meant to hold no credentials (see the class doc comment's Issue #29 note
 * on `secretEntries` above), but the previous version of this logic only
 * gated PROJECT secrets on isolation — it left AZITO_UI_TOKEN/
 * AZITO_AGENT_TOKEN entirely under the scoped-auth flag's compat-mode
 * branch, which is ON BY DEFAULT (AZITO_SCOPED_AUTH is off-by-default, design
 * v3 §12 staged migration). That meant every isolated server, under the
 * hub's default configuration, still received the full-power hub UI token
 * (and, for an `agent`-type isolated server, the hub<->agent-server token)
 * in every task pane it launched — exactly the credential this server was
 * declared to hold none of. Isolation is a stronger, narrower guarantee than
 * the compat-mode flag (which is a global migration switch, not a per-server
 * trust decision), so it must be evaluated independently of — and before —
 * that flag, not as a sub-case nested inside "scoped auth is on".
 *
 * When isolated, both keys are set to the empty string explicitly (not
 * simply omitted) for the same masking reason the scoped-auth branch below
 * already relies on: `tmux new-window -e KEY=...` only stops this call from
 * injecting a key, it does NOT stop the new pane from inheriting a key
 * already present in the tmux SESSION's own environment (verified against
 * tmux 3.4). An explicit empty value always overrides an inherited one.
 */
function applyTokenMaskingOrCompat(
  env: Record<string, string>,
  server: ServerConfig,
  uiToken: string,
  scopedAuthEnabled: boolean,
): void {
  if (server.isolationIntent) {
    // Isolation wins over compat mode unconditionally — see this function's
    // doc comment above for why the previous nesting (compat-mode branch
    // gating isolation) let an isolated server receive full-power tokens
    // under the hub's default (scoped-auth-off) configuration.
    Object.assign(env, ISOLATION_MASKED_ENV);
    return;
  }
  if (!scopedAuthEnabled) {
    // Compat mode: keep injecting exactly what every task pane got before
    // Phase A, so harness skills / azt-mcp / browser-ops that still expect
    // AZITO_UI_TOKEN keep working until every migration stage in design v3
    // §12 has actually been deployed and this flag is flipped on.
    if (uiToken) env.AZITO_UI_TOKEN = uiToken;
    if (server.type === 'agent') {
      if (server.agentPort) env.AZITO_AGENT_PORT = String(server.agentPort);
      if (server.agentToken) env.AZITO_AGENT_TOKEN = server.agentToken;
    }
  } else {
    // Denylist override (Issue #28 third-party review finding, Critical):
    // `tmux new-window -e KEY=...` only stops THIS call from injecting a
    // key — it does NOT stop the new pane from inheriting a key already
    // present in the tmux SESSION's own environment (`tmux new-session -e`
    // persists into the session, and every window created afterwards in
    // that session inherits it — verified directly against tmux 3.4). A
    // task window is very often created inside a pre-existing session
    // (e.g. a project's tmux session, created via
    // `POST /api/projects/:id/servers/:name` with `tmux.uiTokenEnv()`, or
    // any manual "New Session" a human made from the terminal UI) — if
    // that session's env still carries AZITO_UI_TOKEN/AZITO_AGENT_TOKEN
    // from before, a task pane would inherit the full-power UI token (or
    // the hub<->agent-server token) straight through the session, bypassing
    // scoped auth entirely despite this branch never assigning either key
    // itself. Explicitly setting both to '' here forces THIS pane's `-e`
    // override to win regardless of what the session carries — tmux
    // applies a new pane's own `-e` values on top of the inherited session
    // environment, so an explicit empty value always masks an inherited
    // one (confirmed empirically: a session-level var set via `-e` on
    // `new-session` is overridden to empty by `-e KEY=` on a later
    // `new-window` into that same session). This makes cleaning up
    // already-running sessions' leftover env unnecessary: any task window
    // created from here on is safe no matter what a session's own env
    // holds.
    Object.assign(env, ISOLATION_MASKED_ENV);
  }
}

export class TaskPaneEnvironmentService {
  constructor(
    private taskTokenRepo: ITaskTokenRepository,
    private projectSecretRepo: SqliteProjectSecretRepository,
    private uiToken: string,
    private scopedAuthEnabled: boolean,
    // Optional (Issue #28 third-party review Important finding): the
    // audit UI's own description claims task-token issuance/revocation as
    // a category it shows (settings.auditLog.description), but nothing
    // ever called `auditLogService.record()` for either — this class is the
    // sole write path for both (see the class doc comment), so it's the one
    // place that can close that gap for every call site at once.
    // best-effort only (recordAuditBestEffort) — an audit-write failure must
    // never block a token from actually being issued or revoked.
    private auditLogService?: AuditLogService,
  ) {}

  /**
   * Rotates (revokes-and-reissues) this task's AZITO_TASK_TOKEN and returns
   * the full env for the new window: the token, AZITO_TASK_ID, every project
   * secret (`AZITO_SECRET_<name>`, same as the pre-Phase-A `buildExtraEnv`
   * this class replaces), and — ONLY while AZITO_SCOPED_AUTH is off (design
   * v3 §12 staged migration) — AZITO_UI_TOKEN and, for an `agent`-type
   * server, AZITO_AGENT_TOKEN/AZITO_AGENT_PORT. Once the flag is on, none of
   * those three are injected: a task pane authenticates purely via its task
   * token, and hub<->agent-server auth (AZITO_AGENT_TOKEN) stops being
   * something a task pane carries at all (design v3 §2 — browser-ops moving
   * off direct CDP-in-the-task-env is a separate round, "E").
   */
  buildEnvForNewWindow(task: Task, server: ServerConfig): { env: Record<string, string>; tokenId: number } {
    // Secrets are read BEFORE the token is rotated (third-party review
    // finding): findByProjectWithValues() decrypts each secret's stored
    // value, which can throw (corrupt row, master-key mismatch, etc). The
    // old order called issueNextGeneration() first — a decrypt failure after
    // that point revoked the previous generation (no window was ever
    // created to carry the new one) with no way for the caller to recover
    // it, since createRotatedWindow's own rollback only runs once `create()`
    // itself has been invoked. Reading secrets first means the only
    // remaining fallible step after rotation is `create()`, which
    // createRotatedWindow already rolls back correctly.
    // Isolation intent (Issue #29 design v2, 層3「遮断」): a server declared
    // isolation_intent=1 is meant to hold no credentials, so this is the ONE
    // place — the single call site every execute/restore/respawn/recovery/
    // splitPane path funnels through (see the class doc comment above) —
    // that withholds project secrets from it. Skipped entirely (not just
    // filtered post-decrypt) so an isolated server's window never even
    // triggers a secret decrypt.
    //
    // Deliberate exception planned, not yet implemented: pushing案A (a later
    // task) will need exactly one isolation-push credential to reach an
    // isolated server so it can still push/PR its own work — when that
    // lands, it is injected as its own dedicated env var here, NOT by
    // relaxing this skip to let ordinary AZITO_SECRET_* rows back in.
    const secretEntries = server.isolationIntent ? [] : this.projectSecretRepo.findByProjectWithValues(task.projectId);
    const issued = this.taskTokenRepo.issueNextGeneration(task.id, 'window_regenerated');
    // Generation number + reason only (design v3 §10: detail must never
    // carry secret material) — `issued.token` (the plaintext) is
    // deliberately excluded.
    recordAuditBestEffort(this.auditLogService, {
      actorClass: 'task',
      actorId: task.id,
      event: 'task_token.issued',
      detail: { taskId: task.id, tokenId: issued.id, reason: 'window_regenerated' },
    });
    const env: Record<string, string> = {
      AZITO_TASK_TOKEN: issued.token,
      AZITO_TASK_ID: String(task.id),
    };
    for (const secret of secretEntries) {
      env[`AZITO_SECRET_${secret.name}`] = secret.value;
    }
    applyTokenMaskingOrCompat(env, server, this.uiToken, this.scopedAuthEnabled);
    return { env, tokenId: issued.id };
  }

  /**
   * Env for a task-owned window that is NOT the task's primary worker window
   * (Issue #28 third-party review finding — multi-window token rotation
   * collision): a secondary window (added via `POST /api/tasks/:id/windows`)
   * is not a caller of the task's own API surface, so it has no reason to
   * hold `AZITO_TASK_TOKEN` — and unlike {@link buildEnvForNewWindow}, this
   * method never calls `issueNextGeneration` (which would revoke the primary
   * window's own still-live generation as a side effect; `ITaskTokenRepository`
   * keeps at most one active generation per task) or touches the token
   * repository at all. It still applies the same AZITO_UI_TOKEN/
   * AZITO_AGENT_TOKEN compat-mode-or-mask split {@link buildEnvForNewWindow}
   * does — a secondary window is exactly as exposed to a leftover session
   * environment as a primary one (see that method's masking comment) — just
   * without ever handing out a task token or the project's secrets.
   *
   * Callers: `WindowRespawnService.respawn()` for a secondary window's
   * (re)creation. Never call this for the primary window — see
   * `isPrimaryTaskWindow`'s doc comment for how callers tell the two apart.
   */
  buildEnvForSecondaryWindow(task: Task, server: ServerConfig): Record<string, string> {
    const env: Record<string, string> = { AZITO_TASK_ID: String(task.id) };
    applyTokenMaskingOrCompat(env, server, this.uiToken, this.scopedAuthEnabled);
    return env;
  }

  /**
   * Revokes exactly the token generation `tokenId` because its backing tmux
   * window was just destroyed (or never came up) and, per design v3 §2's
   * generation-bound contract ("ウィンドウが再利用可能な間だけトークンが
   * 有効"), a destroyed window can never again be resumed onto — so nothing
   * should still hold a live credential for it.
   *
   * Scoped to the single generation `tokenId` identifies — NOT every active
   * generation for the task (Issue #28 third-party review, WindowRotation.ts
   * finding: a blanket `revokeAllForTask` here could revoke a DIFFERENT,
   * newer generation than the one this rollback is actually cleaning up, if
   * a concurrent rotation for the same task had already issued and persisted
   * it — see ITaskTokenRepository.revoke's doc comment). Callers pass the
   * `tokenId` returned by the `buildEnvForNewWindow` call that issued the
   * generation being rolled back — see WindowRotation.ts's
   * createRotatedWindow/rollbackWindowReference.
   *
   * This is deliberately NOT routed through SqliteTaskRepository's
   * TOKEN_REVOKING_STATUSES (the status-transition side of this same
   * contract, see ITaskTokenRepository's doc comment): the call sites this
   * method exists for kill a just-created window on a rollback path that
   * leaves the task at a status TOKEN_REVOKING_STATUSES intentionally does
   * NOT auto-revoke (e.g. 'failed', which stays resumable via follow-up onto
   * a DIFFERENT, later window) — this generation specifically, not the task
   * as a whole, is what just became unusable.
   *
   * Callers MUST confirm the window kill actually succeeded before calling
   * this (Issue #28 third-party review finding: revoking on a kill attempt
   * that silently failed would 401 a pane that is, in fact, still alive and
   * in use).
   */
  revokeGeneration(tokenId: number, reason: string): void {
    const revokedCount = this.taskTokenRepo.revoke(tokenId, reason);
    // Only log an actual revoke (Issue #28 review: the flood-dedup key
    // already collapses identical repeats, but a no-op call — the row was
    // already revoked — must not fabricate a revocation event that didn't
    // happen). No taskId is available at this call's scope (see the class's
    // callers — WindowRotation.ts only holds `tokenId`), so this is
    // recorded against the generation alone; `revokeForDestroyedWindow`
    // below is the task-scoped counterpart.
    if (revokedCount > 0) {
      recordAuditBestEffort(this.auditLogService, {
        actorClass: 'task',
        actorId: null,
        event: 'task_token.revoked',
        detail: { tokenId, reason },
      });
    }
  }

  /**
   * Revokes every currently-active token generation for `taskId`. Unlike
   * {@link revokeGeneration}, this is for callers that are NOT rolling back
   * one specific `createRotatedWindow`/`buildEnvForNewWindow` issuance they
   * hold the `tokenId` for — e.g. an operator killing a task's tmux window
   * directly from the terminal UI (`onTaskWindowDestroyed`,
   * `revokeTaskWindowGeneration` in app/buildServer.ts) — where whatever
   * generation is currently active for the task, known or not, needs to go.
   * Kept alongside `revokeGeneration` rather than folded into it: using this
   * broader form from a rotation-rollback path is exactly the Issue #28
   * third-party review finding `revokeGeneration` exists to avoid (see its
   * doc comment) — a caller that DOES know its own `tokenId` must use
   * `revokeGeneration`, not this method.
   */
  revokeForDestroyedWindow(taskId: number, reason: string): void {
    const revokedCount = this.taskTokenRepo.revokeAllForTask(taskId, reason);
    if (revokedCount > 0) {
      recordAuditBestEffort(this.auditLogService, {
        actorClass: 'task',
        actorId: taskId,
        event: 'task_token.revoked',
        detail: { taskId, reason, revokedCount },
      });
    }
  }
}
