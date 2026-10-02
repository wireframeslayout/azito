import type { MuxDriverKind } from '@azito/shared';

export type MuxDriverUnavailableReason = 'misao_disabled' | 'driver_not_registered' | 'daemon_unreachable' | 'remote_unsupported';

const UNAVAILABLE_MESSAGES: Record<MuxDriverUnavailableReason, (kind: MuxDriverKind) => string> = {
  misao_disabled: (kind) => `Mux driver for kind "${kind}" is disabled (set AZITO_EXPERIMENTAL_MISAO=1 to enable)`,
  driver_not_registered: (kind) => `No mux driver registered for kind "${kind}"`,
  daemon_unreachable: (kind) => `The "${kind}" daemon is not reachable`,
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
