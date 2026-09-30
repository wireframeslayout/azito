import type { MuxDriverKind } from '@azito/shared';

export class MuxDriverUnavailableError extends Error {
  readonly kind: MuxDriverKind;
  constructor(kind: MuxDriverKind) {
    super(`No mux driver registered for kind "${kind}"`);
    this.name = 'MuxDriverUnavailableError';
    this.kind = kind;
  }
}

