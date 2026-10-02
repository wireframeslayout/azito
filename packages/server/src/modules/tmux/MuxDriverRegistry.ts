import type { MuxDriverKind } from '@azito/shared';
import { muxKindForRuntime } from '@azito/shared';
import type { IMuxClient } from './IMuxClient';
import type { ServerConfig } from '../servers/Server';
import { MuxDriverUnavailableError, type MuxDriverUnavailableReason } from './MuxCapabilityError';

export type MuxDriverAvailability = { available: true } | { available: false; reason: MuxDriverUnavailableReason };

export interface MuxDriverRegistryOptions {
  misaoEnabled?: boolean;
}

export class MuxDriverRegistry {
  private drivers = new Map<MuxDriverKind, IMuxClient>();
  private misaoEnabled: boolean;

  constructor(options: MuxDriverRegistryOptions = {}) {
    this.misaoEnabled = options.misaoEnabled ?? false;
  }

  register(kind: MuxDriverKind, driver: IMuxClient): void {
    this.drivers.set(kind, driver);
  }

  availability(server: Pick<ServerConfig, 'muxRuntime'>): MuxDriverAvailability {
    const kind = muxKindForRuntime(server.muxRuntime);
    if (kind === 'misao' && !this.misaoEnabled) return { available: false, reason: 'misao_disabled' };
    if (!this.drivers.has(kind)) return { available: false, reason: 'driver_not_registered' };
    return { available: true };
  }

  resolve(server: Pick<ServerConfig, 'muxRuntime'>): IMuxClient {
    const availability = this.availability(server);
    if (!availability.available) throw new MuxDriverUnavailableError(muxKindForRuntime(server.muxRuntime), availability.reason);
    return this.drivers.get(muxKindForRuntime(server.muxRuntime))!;
  }

  has(kind: MuxDriverKind): boolean {
    return this.drivers.has(kind);
  }
}
