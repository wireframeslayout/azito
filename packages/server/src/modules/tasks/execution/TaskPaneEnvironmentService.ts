import type { ServerConfig } from '../../servers/Server';
import type { Task } from '../Task';
import type { ITaskTokenRepository } from '../tokens/TaskToken';
import type { SqliteProjectSecretRepository } from '../../projects/SqliteProjectSecretRepository';

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
export class TaskPaneEnvironmentService {
  constructor(
    private taskTokenRepo: ITaskTokenRepository,
    private projectSecretRepo: SqliteProjectSecretRepository,
    private uiToken: string,
    private scopedAuthEnabled: boolean,
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
    const secretEntries = this.projectSecretRepo.findByProjectWithValues(task.projectId);
    const issued = this.taskTokenRepo.issueNextGeneration(task.id, 'window_regenerated');
    const env: Record<string, string> = {
      AZITO_TASK_TOKEN: issued.token,
      AZITO_TASK_ID: String(task.id),
    };
    for (const secret of secretEntries) {
      env[`AZITO_SECRET_${secret.name}`] = secret.value;
    }
    if (!this.scopedAuthEnabled) {
      // Compat mode: keep injecting exactly what every task pane got before
      // Phase A, so harness skills / azt-mcp / browser-ops that still expect
      // AZITO_UI_TOKEN keep working until every migration stage in design v3
      // §12 has actually been deployed and this flag is flipped on.
      if (this.uiToken) env.AZITO_UI_TOKEN = this.uiToken;
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
      env.AZITO_UI_TOKEN = '';
      env.AZITO_AGENT_TOKEN = '';
    }
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
    if (!this.scopedAuthEnabled) {
      if (this.uiToken) env.AZITO_UI_TOKEN = this.uiToken;
      if (server.type === 'agent') {
        if (server.agentPort) env.AZITO_AGENT_PORT = String(server.agentPort);
        if (server.agentToken) env.AZITO_AGENT_TOKEN = server.agentToken;
      }
    } else {
      env.AZITO_UI_TOKEN = '';
      env.AZITO_AGENT_TOKEN = '';
    }
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
    this.taskTokenRepo.revoke(tokenId, reason);
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
    this.taskTokenRepo.revokeAllForTask(taskId, reason);
  }
}
