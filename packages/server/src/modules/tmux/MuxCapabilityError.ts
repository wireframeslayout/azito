import type { MuxDriverKind } from '@azito/shared';

export type MuxDriverUnavailableReason = 'misao_disabled' | 'driver_not_registered';

export class MuxDriverUnavailableError extends Error {
  readonly kind: MuxDriverKind;
  readonly reason: MuxDriverUnavailableReason;
  constructor(kind: MuxDriverKind, reason: MuxDriverUnavailableReason = 'driver_not_registered') {
    super(reason === 'misao_disabled'
      ? `Mux driver for kind "${kind}" is disabled (set AZITO_EXPERIMENTAL_MISAO=1 to enable)`
      : `No mux driver registered for kind "${kind}"`);
    this.name = 'MuxDriverUnavailableError';
    this.kind = kind;
    this.reason = reason;
  }
}
