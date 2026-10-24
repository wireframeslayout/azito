import { hostPathFor } from '@azito/shared';
import { pathRulesOf, type HostEnv, type HostPlatform } from './hostEnv';

/** 相手ホストの OS と一時フォルダ。agent が `GET /api/host` で報告したもの（未記録の旧 agent は Unix の `/tmp`）。 */
export interface AgentTempHost {
  readonly platform: HostPlatform;
  readonly tmpDir: string;
}

/** タスクの一時ファイル（signal / pipe の追跡先、output、rules）を置くサーバー。agent は相手の OS と一時フォルダで決まる。 */
export type TaskTempServer = { readonly type: 'local' } | ({ readonly type: 'agent' } & AgentTempHost);

/**
 * Unix の旧配置（`/tmp` 固定）。ハブの `os.tmpdir()` が `/tmp` 以外（macOS の `$TMPDIR` など）になった後も、
 * 旧配置に残ったファイルを復旧・片付けで拾うために読む。OS を記録していない旧 agent も `/tmp`。
 */
export const LEGACY_UNIX_TMP_DIR = '/tmp';

/** Characters a Unix temp folder may contain, since its paths are embedded unquoted in shell commands. */
const SHELL_SAFE_PATH = /^[A-Za-z0-9_./@:+,=%~-]+$/;

/**
 * A Unix temp folder with a space or shell metacharacter would split the task files' paths, which are written, unquoted,
 * into shell commands (tmux pipe-pane, the commands in the worker's prompt). A Windows one is not written into a shell line.
 * `subject` names whose folder it is, for the message.
 */
export function assertTmpDirShellSafe(platform: NodeJS.Platform, tmpDir: string, subject: string): void {
  if (platform !== 'win32' && !SHELL_SAFE_PATH.test(tmpDir)) {
    throw new Error(`The temp directory "${tmpDir}" of ${subject} contains characters that are not safe in shell commands (allowed: letters, digits and _ . / @ : + , = % ~ -); set TMPDIR to another directory`);
  }
}

/**
 * signal / pipe / output / rules ファイルのパスを 1 か所で決める。
 * - ハブ自身（`local`）のサーバーは、ハブの一時フォルダ（`HostEnv.tmpDir`）に置く。
 * - agent サーバーは、相手の OS（`path.win32` / `path.posix`）と相手が報告した一時フォルダで決める。
 * 作ったパスは execution_log に記録され、復旧・片付けは記録されたパスを優先する。
 */
export class TaskTempFiles {
  constructor(readonly hubTmpDir: string, readonly hubPlatform: NodeJS.Platform) {
    if (hubTmpDir === '') throw new Error('TaskTempFiles: hubTmpDir must not be empty');
  }

  /**
   * The hub's task files are written, unquoted, into shell commands (tmux pipe-pane, the commands in the worker's prompt). The
   * hub refuses an unsafe Unix temp folder at startup instead of failing task by task (an agent's is checked when it is read).
   */
  assertHubDirShellSafe(): void {
    assertTmpDirShellSafe(this.hubPlatform, this.hubTmpDir, 'the hub');
  }

  static fromHostEnv(hostEnv: Pick<HostEnv, 'tmpDir' | 'platform'>): TaskTempFiles {
    return new TaskTempFiles(hostEnv.tmpDir, hostEnv.platform);
  }

  /** pane の出力を追跡するファイル（`PaneOutputStream` / `AgentPaneStream`）。signal ファイルも `<taskId>-sig` の paneId でここに入る。 */
  pipeFile(server: TaskTempServer, paneId: string, stamp: number): string {
    return this.join(server, `azito-pipe-${paneId}-${stamp}.log`);
  }

  /** ワーカーが結果を書き出す output ファイル。 */
  outputFile(server: TaskTempServer, taskId: number, nonce: string): string {
    return this.join(server, `azito-output-${taskId}-${nonce}.md`);
  }

  /** サブエージェントに渡す rules ファイル。 */
  rulesFile(server: TaskTempServer, taskId: number, nonce: string): string {
    return this.join(server, `azito-rules-${taskId}-${nonce}.md`);
  }

  /** ハブ自身のサーバーのファイルを探す（復旧）・消す（片付け）フォルダ。現在の配置を先頭に、Unix では旧 `/tmp` を足す。 */
  hubScanDirs(): string[] {
    const dirs = [this.hubTmpDir];
    if (this.hubPlatform !== 'win32' && this.hubTmpDir !== LEGACY_UNIX_TMP_DIR) dirs.push(LEGACY_UNIX_TMP_DIR);
    return dirs;
  }

  /** タスクの一時ファイルのファイル名の接頭辞（片付け用）。 */
  static prefixesForTask(taskId: number): string[] {
    return [`azito-pipe-${taskId}-`, `azito-output-${taskId}-`, `azito-rules-${taskId}-`];
  }

  /** タスクの signal ファイルのファイル名の接頭辞（復旧用）。 */
  static signalPrefixForTask(taskId: number): string {
    return `azito-pipe-${taskId}-sig-`;
  }

  /**
   * agent サーバーの pipe ファイル。相手ホストの OS と一時フォルダで決まる。`AgentTransport` が `TaskTempFiles` を持たずに
   * 使えるよう static にしてある。
   */
  static remotePipeFile(host: AgentTempHost, paneId: string, stamp: number): string {
    return hostPathFor(host.platform).join(host.tmpDir, `azito-pipe-${paneId}-${stamp}.log`);
  }

  private join(server: TaskTempServer, fileName: string): string {
    if (server.type === 'local') return hostPathFor(pathRulesOf(this.hubPlatform)).join(this.hubTmpDir, fileName);
    return hostPathFor(server.platform).join(server.tmpDir, fileName);
  }
}
