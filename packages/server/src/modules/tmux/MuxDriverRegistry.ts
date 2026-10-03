import type { MuxDriverKind } from '@azito/shared';
import type { IMuxClient } from './IMuxClient';
import type { ServerConfig } from '../servers/Server';
import { MuxDriverUnavailableError, type MuxDriverUnavailableReason } from './MuxCapabilityError';

export type MuxDriverAvailability = { available: true } | { available: false; reason: MuxDriverUnavailableReason };

/** What a driver probe looks at. `type` is optional: callers that only know the kind skip type-dependent probe checks. */
export type MuxProbeTarget = Partial<Pick<ServerConfig, 'type'>>;

/** A server as the registry sees it: its default mux kind plus the probe target fields. */
export type MuxServerRef = Pick<ServerConfig, 'defaultMux'> & MuxProbeTarget;

/** Evaluated last by `availabilityFor()`; lets a driver report a runtime condition (remote server, daemon down). */
export type MuxDriverProbe = (server: MuxProbeTarget) => MuxDriverAvailability;

export class MuxDriverRegistry {
  private drivers = new Map<MuxDriverKind, { driver: IMuxClient; probe?: MuxDriverProbe }>();

  register(kind: MuxDriverKind, driver: IMuxClient, probe?: MuxDriverProbe): void {
    this.drivers.set(kind, { driver, probe });
  }

  availabilityFor(kind: MuxDriverKind, server: MuxProbeTarget): MuxDriverAvailability {
    const entry = this.drivers.get(kind);
    if (!entry) return { available: false, reason: 'driver_not_registered' };
    return entry.probe?.(server) ?? { available: true };
  }

  resolveKind(kind: MuxDriverKind, server: MuxProbeTarget): IMuxClient {
    const availability = this.availabilityFor(kind, server);
    if (!availability.available) throw new MuxDriverUnavailableError(kind, availability.reason);
    return this.drivers.get(kind)!.driver;
  }

  availability(server: MuxServerRef): MuxDriverAvailability {
    return this.availabilityFor(server.defaultMux, server);
  }

  /** Alias of `resolveKind(server.defaultMux, server)`: the server-wide default driver. */
  resolve(server: MuxServerRef): IMuxClient {
    return this.resolveKind(server.defaultMux, server);
  }
}
