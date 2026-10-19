import { z } from 'zod';

/** Upper bounds a caller (the hub, or a request to an agent) cannot exceed. */
export const MAX_COMMAND_TIMEOUT_MS = 600_000;
export const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;

const noNul = (s: string): boolean => !s.includes('\0');

export const commandSpecSchema = z.object({
  /** The program: a name looked up on the host's PATH, or a path. Never a shell command line. */
  file: z.string().min(1).refine(noNul, 'file must not contain a NUL byte'),
  /** One string per argument, passed to the program as they are (no shell splitting, no expansion). */
  args: z.array(z.string().refine(noNul, 'an argument must not contain a NUL byte')),
  cwd: z.string().min(1).refine(noNul, 'cwd must not contain a NUL byte').optional(),
  /** Added to the host process's own environment. */
  env: z.record(z.string(), z.string().refine(noNul, 'an env value must not contain a NUL byte')).optional(),
  stdin: z.string().optional(),
  timeoutMs: z.number().int().positive().max(MAX_COMMAND_TIMEOUT_MS),
  /** stdout and stderr are each capped at this many bytes. */
  maxOutputBytes: z.number().int().positive().max(MAX_COMMAND_OUTPUT_BYTES),
});

/**
 * A program and its arguments, run by the Node process on the host that owns them without a shell
 * (the hub for a local server, the agent for an agent server). Validated at every boundary a spec crosses.
 */
export type CommandSpec = z.infer<typeof commandSpecSchema>;

/** Reads a spec from untrusted input (an agent's request body). Throws a ZodError on a malformed one. */
export function parseCommandSpec(input: unknown): CommandSpec {
  return commandSpecSchema.parse(input);
}

/**
 * How a command ended when it did run to the end. A non-zero `exitCode` is a result, not an error.
 * A process killed by a signal that is not ours has `signal` set and `exitCode` 128 + the signal number.
 */
export interface CommandResult {
  exitCode: number;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/** What went wrong before a result existed. Every one keeps the output produced so far. */
export type CommandFailureKind = 'spawn_failed' | 'timeout' | 'output_limit';

export abstract class CommandError extends Error {
  abstract readonly kind: CommandFailureKind;
  constructor(message: string, readonly stdout: string, readonly stderr: string) {
    super(message);
  }
}

/** The program could not be started (not found, not executable, bad cwd, a file the runner refuses). */
export class CommandSpawnError extends CommandError {
  readonly kind = 'spawn_failed';
  /** The system error code (`ENOENT`, `EACCES`...) or `UNSUPPORTED_FILE` for a file the runner refuses. */
  constructor(readonly code: string, message: string, stdout = '', stderr = '') {
    super(message, stdout, stderr);
    this.name = 'CommandSpawnError';
  }
}

/** The command ran past its deadline and was killed. */
export class CommandTimeoutError extends CommandError {
  readonly kind = 'timeout';
  constructor(readonly timeoutMs: number, stdout: string, stderr: string) {
    super(`Command timed out after ${timeoutMs}ms`, stdout, stderr);
    this.name = 'CommandTimeoutError';
  }
}

/** The command wrote more than `maxOutputBytes` to stdout or stderr and was killed. */
export class CommandOutputLimitError extends CommandError {
  readonly kind = 'output_limit';
  constructor(readonly maxOutputBytes: number, stdout: string, stderr: string) {
    super(`Command output exceeded ${maxOutputBytes} bytes`, stdout, stderr);
    this.name = 'CommandOutputLimitError';
  }
}

/** The deadline and output cap a call gets when it names none (the agent's own `exec` default timeout, and room for a large diff). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
export const DEFAULT_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;

export type CommandSpecOptions = Partial<Pick<CommandSpec, 'cwd' | 'env' | 'stdin' | 'timeoutMs' | 'maxOutputBytes'>>;

/** Builds a spec from a program, its arguments and the options a call cares about. */
export function buildCommandSpec(file: string, args: string[], options: CommandSpecOptions = {}): CommandSpec {
  return {
    file,
    args,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_COMMAND_OUTPUT_BYTES,
  };
}
