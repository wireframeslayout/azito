import type { MuxDriverKind } from '@azito/shared';

export type MuxDriverUnavailableReason = 'driver_not_registered' | 'daemon_unreachable' | 'protocol_incompatible' | 'remote_unsupported';

const UNAVAILABLE_MESSAGES: Record<MuxDriverUnavailableReason, (kind: MuxDriverKind) => string> = {
  driver_not_registered: (kind) => `No mux driver registered for kind "${kind}"`,
  daemon_unreachable: (kind) => `The "${kind}" daemon is not reachable`,
  protocol_incompatible: (kind) => `The "${kind}" daemon speaks a protocol this hub cannot use`,
  remote_unsupported: (kind) => `Mux driver "${kind}" supports local servers only`,
};

export class MuxDriverUnavailableError extends Error {
  readonly kind: MuxDriverKind;
  readonly reason: MuxDriverUnavailableReason;
  constructor(kind: MuxDriverKind, reason: MuxDriverUnavailableReason) {
    super(UNAVAILABLE_MESSAGES[reason](kind));
    this.name = 'MuxDriverUnavailableError';
    this.kind = kind;
    this.reason = reason;
  }
}

/** Thrown by a driver for an IMuxClient operation it does not implement (its caps say so). */
export class MuxOperationUnsupportedError extends Error {
  readonly kind: MuxDriverKind;
  readonly operation: string;
  constructor(kind: MuxDriverKind, operation: string) {
    super(`Mux driver "${kind}" does not support ${operation}`);
    this.name = 'MuxOperationUnsupportedError';
    this.kind = kind;
    this.operation = operation;
  }
}

/** The reason code for a mux whose binary is not installed (a spawn ENOENT, or a remote shell's "command not found"). */
export const MUX_BINARY_MISSING = 'binary_missing';

/**
 * Whether a thrown error says the tmux executable itself is missing: a local spawn error with `code === 'ENOENT'`.
 * Message text is deliberately not matched: "No such file or directory" is also what tmux says when its server
 * socket is absent ("error connecting to ... (No such file or directory)"), which is not a missing binary.
 * tmux only: callers must not apply it to another mux's errors.
 */
export function isMissingBinaryError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/**
 * Whether a non-zero ExecResult says the tmux executable is missing: exit code 127 or "command not found" (an SSH
 * shell's answer). An agent server cannot reach this: the agent turns a spawn ENOENT into code 1 with an empty stderr
 * (agent/routes.ts), so a missing tmux there stays a plain 500 (a failure, but without the reason).
 */
export function isMissingBinaryResult(result: { code: number; stderr: string; stdout: string }): boolean {
  return result.code === 127 || /command not found/i.test(`${result.stderr}\n${result.stdout}`);
}
