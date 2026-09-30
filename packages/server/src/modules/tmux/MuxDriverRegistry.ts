import type { MuxDriverKind } from '@azito/shared';
import { muxKindForRuntime } from '@azito/shared';
import type { IMuxClient } from './IMuxClient';
import type { ServerConfig } from '../servers/Server';
import { MuxDriverUnavailableError } from './MuxCapabilityError';

export class MuxDriverRegistry {
  private drivers = new Map<MuxDriverKind, IMuxClient>();

  register(kind: MuxDriverKind, driver: IMuxClient): void {
    this.drivers.set(kind, driver);
  }

  resolve(server: Pick<ServerConfig, 'muxRuntime'>): IMuxClient {
    const kind = muxKindForRuntime(server.muxRuntime);
    const driver = this.drivers.get(kind);
    if (!driver) throw new MuxDriverUnavailableError(kind);
    return driver;
  }

  has(kind: MuxDriverKind): boolean {
    return this.drivers.has(kind);
  }
}
