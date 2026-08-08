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
    }
    return env;
  }
}
