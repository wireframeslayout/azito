import type { EventEmitter } from 'events';
import type { MuxRef, PaneHandle, PaneOrdinal } from '@azito/shared';
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
  /** @deprecated Use IMuxTransport.execMux */
  execTmux(args: string[]): Promise<ExecResult>;
  /** @deprecated Use IMuxTransport.openTerminal */
  openTerminal(target: string, cols: number, rows: number): Promise<ITerminalStream>;
  /** @deprecated Use IMuxTransport.createPaneStream */
  createPaneStream(paneId: string): IPaneStream;
}

export interface IMuxTransport {
  execMux(args: string[]): Promise<ExecResult>;
  openTerminal(ref: MuxRef, ordinal: PaneOrdinal, cols: number, rows: number): Promise<ITerminalStream>;
  createPaneStream(handle: PaneHandle): IPaneStream;
}
