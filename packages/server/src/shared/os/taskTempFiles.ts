import * as path from 'path';
import type { HostEnv } from './hostEnv';

/** タスクの一時ファイル（signal / pipe の追跡先、output、rules）を置くサーバーの種別。 */
export interface TaskTempServer {
  readonly type: 'local' | 'agent';
}

/**
 * Unix の旧配置（`/tmp` 固定）。ハブの `os.tmpdir()` が `/tmp` 以外（macOS の `$TMPDIR` など）になった後も、
 * 旧配置に残ったファイルを復旧・片付けで拾うために読む。リモートサーバー（agent）は P5 まで `/tmp` のまま。
 */
const LEGACY_UNIX_TMP_DIR = '/tmp';

/** Characters a Unix temp folder may contain, since its paths are embedded unquoted in shell commands. */
const SHELL_SAFE_PATH = /^[A-Za-z0-9_./@:+,=%~-]+$/;

/**
 * signal / pipe / output / rules ファイルのパスを 1 か所で決める。
 * - ハブ自身（`local`）のサーバーは、ハブの一時フォルダ（`HostEnv.tmpDir`）に置く。
 * - agent サーバーは相手の OS をまだ知らないので `/tmp` のまま。サーバーを受け取る形にしてあるので、
 *   P5 で相手の hostProfile から決めるように差し替える。
 * 作ったパスは execution_log に記録され、復旧・片付けは記録されたパスを優先する。
 */
export class TaskTempFiles {
  constructor(private readonly hubTmpDir: string, readonly hubPlatform: NodeJS.Platform) {
    if (hubTmpDir === '') throw new Error('TaskTempFiles: hubTmpDir must not be empty');
  }

  /**
   * The hub's task files are written, unquoted, into shell commands (tmux pipe-pane, `cat`/`rm`, the commands in the worker's
   * prompt). A Unix temp folder with a space or shell metacharacter would split them, so the hub refuses it at startup instead
   * of failing task by task. (Not part of the constructor: an agent never places task files in its own temp folder.)
   */
  assertHubDirShellSafe(): void {
    if (this.hubPlatform !== 'win32' && !SHELL_SAFE_PATH.test(this.hubTmpDir)) {
      throw new Error(`The temp directory "${this.hubTmpDir}" contains characters that are not safe in shell commands (allowed: letters, digits and _ . / @ : + , = % ~ -); set TMPDIR to another directory`);
    }
  }

  static fromHostEnv(hostEnv: Pick<HostEnv, 'tmpDir' | 'platform'>): TaskTempFiles {
    return new TaskTempFiles(hostEnv.tmpDir, hostEnv.platform);
  }

  /** pane の出力を追跡するファイル（`PaneOutputStream` / `AgentPaneStream`）。signal ファイルも `<taskId>-sig` の paneId でここに入る。 */
  pipeFile(server: TaskTempServer, paneId: string, stamp: number): string {
    if (server.type === 'agent') return TaskTempFiles.remotePipeFile(paneId, stamp);
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
   * agent サーバーの pipe ファイル。ハブの設定に依らず、相手ホストの一時フォルダ（今は `/tmp` 固定）で決まる。
   * `AgentTransport` が `TaskTempFiles` を持たずに使えるよう static にしてある（P5 で相手の hostProfile から決める）。
   */
  static remotePipeFile(paneId: string, stamp: number): string {
    return path.posix.join(LEGACY_UNIX_TMP_DIR, `azito-pipe-${paneId}-${stamp}.log`);
  }

  private join(server: TaskTempServer, fileName: string): string {
    if (server.type === 'local') return path.join(this.hubTmpDir, fileName);
    return path.posix.join(LEGACY_UNIX_TMP_DIR, fileName);
  }
}
