import { spawn, type ChildProcess } from 'child_process';
import { constants as osConstants } from 'os';
import * as path from 'path';
import {
  CommandOutputLimitError,
  CommandSpawnError,
  CommandTimeoutError,
  type CommandResult,
  type CommandSpec,
} from './commandSpec';
import { trimIncompleteUtf8 } from './utf8';
import type { HostEnv } from '../os/hostEnv';
import { sharedGitLocator, type GitLocator, type WindowsProgramEnv } from './windowsGit';

/**
 * `.cmd` / `.bat` are run by cmd.exe, and Node's `execFile` cannot start one without a shell (and starting one through a shell
 * is exactly the quoting problem this API avoids). They are refused on every OS, so the same spec means the same everywhere;
 * name the real executable (`node`, `git.exe`) instead.
 */
const BATCH_FILE = /\.(cmd|bat)$/i;

/** After the polite stop (SIGTERM), how long a command gets before it is killed outright (SIGKILL). */
export const DEFAULT_KILL_GRACE_MS = 2000;
/** After the outright kill, how long to wait for the pipes to close before the call gives up on them and settles anyway. */
const ABANDON_PIPES_MS = 1000;

/**
 * The host the command runs on, resolved at the process's entry (`runHostOf(hostEnv)`): this module reads no `process.env`.
 * On Windows a command is stopped with `taskkill /T /F` (its whole tree, by the absolute path under `systemRoot`; without
 * one only the direct child is killed), where Unix signals its process group.
 */
export type RunHost =
  | { windows: false }
  | {
    windows: true;
    systemRoot: string | undefined;
    /** Finds `git.exe`. Null for a runner that never runs git (the service commands pass no `windowsPrograms`): asking it for git is an error. */
    git: GitLocator | null;
  };

export function runHostOf(hostEnv: Pick<HostEnv, 'platform' | 'systemRoot'> & { windowsPrograms?: WindowsProgramEnv | undefined }): RunHost {
  if (hostEnv.platform !== 'win32') return { windows: false };
  return { windows: true, systemRoot: hostEnv.systemRoot, git: hostEnv.windowsPrograms ? sharedGitLocator(hostEnv.windowsPrograms) : null };
}

/** The name `git` as a spec spells it for every OS (`runGit`), with or without the extension. On Windows it is resolved by the host, see `runCommandSpec`. */
const BARE_GIT = /^git(\.exe)?$/i;

export type RunCommandOptions = RunHost & {
  /** Overrides {@link DEFAULT_KILL_GRACE_MS}. */
  killGraceMs?: number;
  /** Also return the output bytes untouched (`stdoutBytes` / `stderrBytes`); `stdout` / `stderr` stay the UTF-8 text. */
  rawOutput?: boolean;
};

/** One output stream, kept as bytes and cut at the byte limit (`exceeded`: more than the limit was written). */
class Capture {
  private chunks: Buffer[] = [];
  private bytes = 0;
  exceeded = false;

  constructor(private readonly maxBytes: number) {}

  /** Returns true when this chunk is the one that crossed the limit. */
  push(chunk: Buffer): boolean {
    if (this.exceeded) return false;
    const room = this.maxBytes - this.bytes;
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.bytes = this.maxBytes;
      this.exceeded = true;
      return true;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    return false;
  }

  raw(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** `cutShort`: the command was stopped, so the output may end in the middle of a character. */
  text(cutShort: boolean): string {
    const all = Buffer.concat(this.chunks);
    return (cutShort ? trimIncompleteUtf8(all) : all).toString('utf-8');
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone.
  }
}

/** How often the process group left behind is looked at while it is given time to stop. */
const GROUP_POLL_MS = 100;

/**
 * The group's cleanup, apart from the call's own outcome: whatever the leader did, a member that outlives the polite stop
 * is killed when the grace period ends. The group id is the leader's pid. Unix never hands a pid out again while a process
 * is still in a group of that id, so `kill(-pgid)` reaches only our descendants as long as the group has members — which
 * is checked (signal 0) every {@link GROUP_POLL_MS} up to the moment of the kill; an empty group ends the watch.
 * Timers are unref'd: they never keep the process alive.
 */
function reapGroup(child: ChildProcess, graceMs: number): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const killAt = Date.now() + graceMs;
  const timer = setInterval(() => {
    try {
      process.kill(-pid, 0);
    } catch {
      clearInterval(timer); // no member left: nothing to kill, and the id may be reused from now on
      return;
    }
    if (Date.now() >= killAt) {
      clearInterval(timer);
      signalGroup(child, 'SIGKILL');
    }
  }, GROUP_POLL_MS);
  timer.unref();
}

/**
 * Ends the tree of a Windows command with the system's own `taskkill` (by absolute path: a PATH lookup could find another
 * program of that name). Not when the direct child has already exited — its pid may belong to another process by now — and
 * a failed taskkill falls back to killing the direct child; both are reported.
 */
function killWindowsTree(child: ChildProcess, systemRoot: string | undefined): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (!systemRoot) {
    console.warn('[exec] SystemRoot is not set; killing only the direct child of a stopped command');
    child.kill();
    return;
  }
  const taskkill = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
  const killer = spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  const fallBack = (why: string): void => {
    console.warn(`[exec] taskkill did not stop pid ${child.pid} (${why}); killing the direct child`);
    child.kill();
  };
  killer.on('error', (err) => fallBack(err.message));
  killer.on('exit', (code) => { if (code !== 0) fallBack(`exit ${code}`); });
}

/**
 * Runs `spec` without a shell, on the machine this Node process runs on. The hub (local servers) and the agent
 * (`POST /api/run`) both call this, so a spec behaves the same wherever it executes.
 *
 * Resolves with the real exit code, non-zero included. Rejects with a {@link CommandSpawnError} (not startable),
 * {@link CommandTimeoutError} or {@link CommandOutputLimitError}; each carries the output produced so far. The deadline
 * and the output limit are this function's own: once either is hit the command is stopped (SIGTERM to its process group,
 * then SIGKILL after a grace period; the whole tree with `taskkill` on Windows) and the call fails with that reason
 * whatever the command exits with — a command that exits 0 on SIGTERM did not succeed.
 */
export async function runCommandSpec(spec: CommandSpec, options: RunCommandOptions): Promise<CommandResult> {
  // A bare `git` on a Windows host is the `git.exe` of Git for Windows, found by this host (not by the caller: the caller may be a hub
  // asking an agent). Not found: `GitNotFoundError`, never a bare ENOENT.
  if (options.windows && BARE_GIT.test(spec.file)) {
    if (!options.git) throw new Error('This runner has no search for git.exe (its host was resolved without windowsPrograms)');
    return spawnSpec({ ...spec, file: await options.git.resolve() }, options);
  }
  return spawnSpec(spec, options);
}

function spawnSpec(spec: CommandSpec, options: RunCommandOptions): Promise<CommandResult> {
  if (BATCH_FILE.test(spec.file)) {
    return Promise.reject(new CommandSpawnError(
      'UNSUPPORTED_FILE',
      `Cannot run "${spec.file}": .cmd / .bat files need a shell, and commands are run without one. Name the executable itself.`,
    ));
  }
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env ? { ...process.env, ...spec.env } : undefined,
      shell: false,
      windowsHide: true,
      // Its own process group on Unix, so a stop reaches the grandchildren too.
      detached: !options.windows,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout = new Capture(spec.maxOutputBytes);
    const stderr = new Capture(spec.maxOutputBytes);
    const timers: NodeJS.Timeout[] = [];
    let stopReason: 'timeout' | 'output_limit' | null = null;
    let settled = false;

    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      finish();
    };
    const failureOrResult = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      settle(() => {
        const cutShort = stopReason !== null;
        const out = stdout.text(cutShort);
        const err = stderr.text(cutShort);
        if (stopReason === 'timeout') reject(new CommandTimeoutError(spec.timeoutMs, out, err));
        else if (stopReason === 'output_limit') reject(new CommandOutputLimitError(spec.maxOutputBytes, out, err));
        else {
          const raw = options.rawOutput ? { stdoutBytes: stdout.raw(), stderrBytes: stderr.raw() } : {};
          if (exitCode !== null) resolve({ exitCode, signal: null, stdout: out, stderr: err, ...raw });
          else resolve({ exitCode: 128 + (signal ? osConstants.signals[signal] : 0), signal, stdout: out, stderr: err, ...raw });
        }
      });
    };

    const stop = (reason: 'timeout' | 'output_limit'): void => {
      if (stopReason) return;
      stopReason = reason;
      if (options.windows) {
        killWindowsTree(child, options.systemRoot);
      } else {
        signalGroup(child, 'SIGTERM');
        // Not one of `timers`: the call may settle (the leader closes) while members of the group are still running.
        reapGroup(child, killGraceMs);
      }
      // A descendant that kept the pipes open must not hold the call forever.
      timers.push(setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        failureOrResult(child.exitCode, child.signalCode);
      }, killGraceMs + ABANDON_PIPES_MS));
    };

    timers.push(setTimeout(() => stop('timeout'), spec.timeoutMs));
    child.stdout?.on('data', (chunk: Buffer) => { if (stdout.push(chunk)) stop('output_limit'); });
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.push(chunk)) stop('output_limit'); });

    child.on('error', (err: NodeJS.ErrnoException) => {
      // Only a failure to start ends the call here; the process is gone before it ever ran.
      if (child.pid !== undefined) return;
      settle(() => reject(new CommandSpawnError(err.code ?? 'UNKNOWN', err.message, stdout.text(false), stderr.text(false))));
    });
    child.on('close', (exitCode, signal) => failureOrResult(exitCode, signal));

    // A program that exits without reading its stdin breaks the pipe: that is the program's choice, not our failure.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(spec.stdin ?? '');
  });
}
