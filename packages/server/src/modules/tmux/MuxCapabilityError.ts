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

const MISSING_BINARY_TEXT = /ENOENT|command not found|not found: tmux|tmux: not found|No such file or directory/i;

/** Whether a thrown error says the mux binary is not installed (rather than the mux refusing the call). */
export function isMissingBinaryError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT') return true;
  return err instanceof Error && MISSING_BINARY_TEXT.test(err.message);
}

/** Whether a non-zero ExecResult (agent/ssh transports resolve with one instead of throwing) says the binary is missing. */
export function isMissingBinaryResult(result: { code: number; stderr: string; stdout: string }): boolean {
  return result.code === 127 || MISSING_BINARY_TEXT.test(`${result.stderr}\n${result.stdout}`);
}
