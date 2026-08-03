import type { EventEmitter } from 'events';
import type { IPaneStream } from '../../tmux/PaneStream';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** 対話ターミナル1本を表す。'data'(string) / 'close' を emit する */
export interface ITerminalStream extends EventEmitter {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface IServerTransport {
  /** シェルコマンド実行（現行 TmuxClient.execCommand 相当） */
  exec(command: string, timeoutMs?: number): Promise<ExecResult>;
  /** tmuxコマンド実行。引数は構造化して渡し、エスケープはTransport実装の責務とする */
  execTmux(args: string[]): Promise<ExecResult>;
  /** ターミナル接続。リンクセッション作成（new-session -t → set status off → select-window → attach）込み */
  openTerminal(target: string, cols: number, rows: number): Promise<ITerminalStream>;
  /** タスクログ用ペインストリーム（pipe-pane先ファイルのtail） */
  createPaneStream(paneId: string): IPaneStream;
}
