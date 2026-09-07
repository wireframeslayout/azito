import type { MuxDriverKind } from '@azito/shared';

export class MuxDriverUnavailableError extends Error {
  readonly kind: MuxDriverKind;
  constructor(kind: MuxDriverKind) {
    super(`No mux driver registered for kind "${kind}"`);
    this.name = 'MuxDriverUnavailableError';
    this.kind = kind;
  }
}

export class MuxCapabilityMissingError extends Error {
  readonly capability: string;
  constructor(capability: string) {
    super(`Required mux capability "${capability}" is not supported`);
    this.name = 'MuxCapabilityMissingError';
    this.capability = capability;
  }
}
