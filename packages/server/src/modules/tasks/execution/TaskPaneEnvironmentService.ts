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
  buildEnvForNewWindow(task: Task, server: ServerConfig): Record<string, string> {
    const issued = this.taskTokenRepo.issueNextGeneration(task.id, 'window_regenerated');
    const env: Record<string, string> = {
      AZITO_TASK_TOKEN: issued.token,
      AZITO_TASK_ID: String(task.id),
    };
    for (const secret of this.projectSecretRepo.findByProjectWithValues(task.projectId)) {
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
    return env;
  }

  /**
   * Revokes every currently-active token generation for `taskId` because its
   * backing tmux window was just destroyed and, per design v3 §2's
   * generation-bound contract ("ウィンドウが再利用可能な間だけトークンが
   * 有効"), a destroyed window can never again be resumed onto — so nothing
   * should still hold a live credential for it.
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
  revokeForDestroyedWindow(taskId: number, reason: string): void {
    this.taskTokenRepo.revokeAllForTask(taskId, reason);
  }
}
