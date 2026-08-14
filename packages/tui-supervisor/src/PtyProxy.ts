import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';

export interface PtyProxyOptions {
  /**
   * Delay (ms) between the child's exit and process.exit(), so an attached
   * HubClient gets a chance to flush its child_exit message over the WebSocket.
   * 0 = exit immediately (pure pass-through mode).
   */
  exitGraceMs?: number;
}

export interface PtyExitInfo {
  /** Raw child exit code; null when the child died from a signal. */
  exitCode: number | null;
  /** Signal number that killed the child, if any. */
  signal: number | null;
  /** Final supervisor exit code (128 + signal for signal deaths). */
  code: number;
}

/** Quote a value for safe interpolation into a single-quoted shell word. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Environment variables that identify the tmux pane the supervisor runs in.
 * Claude Code's hooks (azito-activity/interaction/notify) resolve their pane
 * through TMUX_PANE, so losing them silences every hook under a supervised
 * window.
 */
const TMUX_PANE_VARS = ['TMUX', 'TMUX_PANE'] as const;

/**
 * Builds the command string handed to `<shell> -lc`.
 *
 * The login shell (`-l`) is kept deliberately: it is what resolves the user's
 * PATH (nvm/nodenv/Homebrew) so the wrapped agent binary is found. But login
 * profiles commonly unset TMUX/TMUX_PANE (they treat them as stale inheritance),
 * which strips the pane identity from the child. Re-exporting the values at the
 * start of the command string restores them *after* profile evaluation, without
 * touching PATH resolution.
 *
 * Nothing is injected when the variables are absent (supervisor started outside
 * tmux) — the command is passed through unchanged.
 */
export function buildLoginShellCommand(cmd: string, env: NodeJS.ProcessEnv): string {
  const assignments = TMUX_PANE_VARS.filter((name) => env[name] !== undefined && env[name] !== '').map(
    (name) => `${name}=${shellSingleQuote(env[name] as string)}`,
  );
  if (assignments.length === 0) return cmd;
  return `export ${assignments.join(' ')}; ${cmd}`;
}

/**
 * Spawns a command inside a PTY and pipes stdin/stdout through it transparently,
 * so a wrapped TUI (e.g. Claude Code) renders identically to running it directly
 * in a tmux pane. Emits 'data' (output byte count + the raw chunk, so
 * TitleStateTracker can scan OSC title sequences inline) and 'exit'
 * (PtyExitInfo) so ActivityTracker/HubClient can observe activity without
 * altering bytes.
 */
export class PtyProxy extends EventEmitter {
  private child: pty.IPty | undefined;
  private wasRawMode = false;
  private readonly exitGraceMs: number;

  constructor(options: PtyProxyOptions = {}) {
    super();
    this.exitGraceMs = options.exitGraceMs ?? 0;
  }

  start(cmd: string): void {
    const shell = process.env.SHELL || '/bin/bash';
    this.child = pty.spawn(shell, ['-lc', buildLoginShellCommand(cmd, process.env)], {
      name: process.env.TERM || 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });

    this.child.onData((data: string) => {
      process.stdout.write(data);
      this.emit('data', Buffer.byteLength(data), data);
    });

    this.child.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      this.restoreStdin();
      // POSIX convention: a signal-killed child exits with 128 + signal number.
      // node-pty reports exitCode and signal separately (exitCode 0 on signal death),
      // so they must be combined here or interrupted runs would look successful.
      const sig = signal || null; // node-pty reports 0 (not undefined) for "no signal"
      const code = sig ? 128 + sig : (exitCode ?? 0);
      const info: PtyExitInfo = {
        exitCode: sig ? null : (exitCode ?? 0),
        signal: sig,
        code,
      };
      this.emit('exit', info);
      if (this.exitGraceMs > 0) {
        setTimeout(() => process.exit(code), this.exitGraceMs);
      } else {
        process.exit(code);
      }
    });

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      this.wasRawMode = true;
    }
    process.stdin.resume();
    // Byte preservation: no setEncoding — stdin chunks stay Buffers and are
    // passed verbatim to the child PTY (node-pty v1.1's IPty.write() accepts
    // string | Buffer and writes Buffers unmodified). Decoding to a JS string
    // here would corrupt non-UTF-8 byte sequences (U+FFFD replacement).
    process.stdin.on('data', (data: Buffer) => {
      this.child?.write(data);
    });
    process.stdin.on('end', () => {
      // Non-TTY parent (e.g. piped input) closed stdin — do not crash, just stop forwarding.
    });

    process.stdout.on('resize', () => {
      this.resize();
    });
    // Sync initial size once more after spawn (columns/rows can settle late).
    this.resize();

    process.on('SIGTERM', () => this.kill('SIGTERM'));
    process.on('SIGHUP', () => this.kill('SIGHUP'));
  }

  /** Write raw bytes into the child PTY (used by HubClient command handling). */
  write(data: string | Buffer): void {
    if (!this.child) throw new Error('PtyProxy not started');
    this.child.write(data);
  }

  /** Forward a signal to the child process. */
  kill(signal: NodeJS.Signals): void {
    this.child?.kill(signal);
  }

  /** Resize the child PTY; defaults to the current stdout dimensions. */
  resize(cols?: number, rows?: number): void {
    if (!this.child) return;
    const c = cols ?? process.stdout.columns ?? 80;
    const r = rows ?? process.stdout.rows ?? 24;
    // Announce the resize so listeners (ActivityTracker) can discount the
    // repaint burst the child emits in response.
    this.emit('resize', c, r);
    try {
      this.child.resize(c, r);
    } catch {
      // Pane may already be gone; ignore.
    }
  }

  private restoreStdin(): void {
    if (this.wasRawMode && process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  }
}
