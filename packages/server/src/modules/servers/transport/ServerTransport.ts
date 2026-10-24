import type { EventEmitter } from 'events';
import type { MuxRef, PaneHandle, PaneOrdinal, MuxExecRequest } from '@azito/shared';
import type { IPaneStream } from '../../tmux/PaneStream';
import type { HostProfile } from '../../../shared/os/hostProfile';
import type { CommandResult, CommandSpec } from '../../../shared/exec/commandSpec';
import type { IFileOps } from '../../../shared/fs/fileOps';
import type { ProcessEntry } from '../../../shared/os/processList';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  /** The driver itself reported the target as nonexistent (misao RPC NotFound); tmux relies on stderr wording instead. */
  alreadyGone?: boolean;
}

/** 対話ターミナル1本を表す。'data'(string) / 'close' を emit する */
export interface ITerminalStream extends EventEmitter {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/** A transport that knows the host it runs on. */
export interface IHostBoundTransport {
  /** The OS / architecture of that host. Null: an agent registered before the OS was recorded (a Unix one). */
  readonly hostProfile: HostProfile | null;
}

export interface IServerTransport {
  /**
   * Runs a program with arguments on the server's host, without a shell (see `CommandSpec`). A non-zero exit is a result;
   * a program that cannot start, a timeout and too much output reject with a `CommandError` that keeps the output so far,
   * and an unreachable agent with `AgentUnreachableError`.
   */
  run(spec: CommandSpec): Promise<CommandResult>;

  /**
   * The file operations of the server's host (Node `fs` there, no shell; see `IFileOps`). The route is chosen here, once, from
   * what is known of the host: never retried through another when it fails.
   */
  files(): IFileOps;

  /**
   * The processes of the server's host (pid / ppid / start time / executable / command line), the same shape for every OS. A host
   * that cannot list them rejects; it is never an empty list.
   */
  listProcesses(): Promise<ProcessEntry[]>;

  /**
   * シェルコマンド実行（現行 TmuxClient.execCommand 相当）
   * @deprecated POSIX-only: runs `command` with `/bin/sh -c`, so a win32 host rejects it with an `unsupported_os` HostProfileError.
   */
  exec(command: string, timeoutMs?: number): Promise<ExecResult>;
}

export interface OpenTerminalOpts {
}

export interface IMuxTransport {
  execMux(req: MuxExecRequest): Promise<ExecResult>;
  openTerminal(ref: MuxRef, ordinal: PaneOrdinal, cols: number, rows: number, opts?: OpenTerminalOpts): Promise<ITerminalStream>;
  createPaneStream(handle: PaneHandle): IPaneStream;
}
