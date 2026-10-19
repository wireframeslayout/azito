import { execFile } from 'child_process';
import { constants as osConstants } from 'os';
import {
  CommandOutputLimitError,
  CommandSpawnError,
  CommandTimeoutError,
  type CommandResult,
  type CommandSpec,
} from './commandSpec';

/**
 * `.cmd` / `.bat` are run by cmd.exe, and Node's `execFile` cannot start one without a shell (and starting one through a shell
 * is exactly the quoting problem this API avoids). They are refused on every OS, so the same spec means the same everywhere;
 * name the real executable (`node`, `git.exe`) instead.
 */
const BATCH_FILE = /\.(cmd|bat)$/i;

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf-8');
  return '';
}

/**
 * Runs `spec` with `execFile` and no shell, on the machine this Node process runs on. The hub (local servers) and the agent
 * (`POST /api/run`) both call this, so a spec behaves the same wherever it executes.
 *
 * Resolves with the real exit code, non-zero included. Rejects with a {@link CommandSpawnError} (not startable),
 * {@link CommandTimeoutError} or {@link CommandOutputLimitError}; each carries the output produced so far.
 */
export function runCommandSpec(spec: CommandSpec): Promise<CommandResult> {
  if (BATCH_FILE.test(spec.file)) {
    return Promise.reject(new CommandSpawnError(
      'UNSUPPORTED_FILE',
      `Cannot run "${spec.file}": .cmd / .bat files need a shell, and commands are run without one. Name the executable itself.`,
    ));
  }

  return new Promise((resolve, reject) => {
    const child = execFile(
      spec.file,
      spec.args,
      {
        cwd: spec.cwd,
        env: spec.env ? { ...process.env, ...spec.env } : undefined,
        timeout: spec.timeoutMs,
        maxBuffer: spec.maxOutputBytes,
        windowsHide: true,
        shell: false,
        encoding: 'utf-8',
      },
      (err, stdoutRaw, stderrRaw) => {
        const stdout = toText(stdoutRaw);
        const stderr = toText(stderrRaw);
        if (!err) {
          resolve({ exitCode: 0, signal: null, stdout, stderr });
          return;
        }
        const failure = err as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null; code?: string | number };
        if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new CommandOutputLimitError(spec.maxOutputBytes, stdout, stderr));
          return;
        }
        if (typeof failure.code === 'number') {
          resolve({ exitCode: failure.code, signal: null, stdout, stderr });
          return;
        }
        if (failure.killed && failure.signal) {
          // execFile kills the child itself only for the timeout (the output limit is reported above); a signal from outside leaves `killed` false.
          reject(new CommandTimeoutError(spec.timeoutMs, stdout, stderr));
          return;
        }
        if (failure.signal) {
          const signalNumber = osConstants.signals[failure.signal];
          resolve({ exitCode: 128 + signalNumber, signal: failure.signal, stdout, stderr });
          return;
        }
        reject(new CommandSpawnError(typeof failure.code === 'string' ? failure.code : 'UNKNOWN', failure.message, stdout, stderr));
      },
    );
    // A program that exits without reading its stdin breaks the pipe: that is the program's choice, not our failure.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(spec.stdin ?? '');
  });
}
