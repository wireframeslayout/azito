import type { MuxDriverKind } from '@azito/shared';
import { muxKindForRuntime } from '@azito/shared';
import type { IMuxClient } from './IMuxClient';
import type { ServerConfig } from '../servers/Server';
import { MuxDriverUnavailableError, type MuxDriverUnavailableReason } from './MuxCapabilityError';

export type MuxDriverAvailability = { available: true } | { available: false; reason: MuxDriverUnavailableReason };

export interface MuxDriverRegistryOptions {
  misaoEnabled?: boolean;
}

/** The server fields availability depends on. `type` is optional: callers that only know the runtime skip type-dependent probe checks. */
export type MuxServerRef = Pick<ServerConfig, 'muxRuntime'> & Partial<Pick<ServerConfig, 'type'>>;

/** Evaluated last by `availability()`; lets a driver report a runtime condition (remote server, daemon down). */
export type MuxDriverProbe = (server: MuxServerRef) => MuxDriverAvailability;

export class MuxDriverRegistry {
  private drivers = new Map<MuxDriverKind, { driver: IMuxClient; probe?: MuxDriverProbe }>();
  private misaoEnabled: boolean;

  constructor(options: MuxDriverRegistryOptions = {}) {
    this.misaoEnabled = options.misaoEnabled ?? false;
  }

  register(kind: MuxDriverKind, driver: IMuxClient, probe?: MuxDriverProbe): void {
    this.drivers.set(kind, { driver, probe });
  }

  availability(server: MuxServerRef): MuxDriverAvailability {
    const kind = muxKindForRuntime(server.muxRuntime);
    if (kind === 'misao' && !this.misaoEnabled) return { available: false, reason: 'misao_disabled' };
    const entry = this.drivers.get(kind);
    if (!entry) return { available: false, reason: 'driver_not_registered' };
    return entry.probe?.(server) ?? { available: true };
  }

  resolve(server: MuxServerRef): IMuxClient {
    const availability = this.availability(server);
    if (!availability.available) throw new MuxDriverUnavailableError(muxKindForRuntime(server.muxRuntime), availability.reason);
    return this.drivers.get(muxKindForRuntime(server.muxRuntime))!.driver;
  }
}
