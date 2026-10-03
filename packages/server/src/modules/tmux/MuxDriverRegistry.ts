import type { MuxDriverKind } from '@azito/shared';
import type { IMuxClient } from './IMuxClient';
import type { ServerConfig } from '../servers/Server';
import { MuxDriverUnavailableError, type MuxDriverUnavailableReason } from './MuxCapabilityError';
import { RoutingMuxClient, type RoutingUnavailableState } from './RoutingMuxClient';

const MUX_DRIVER_KINDS: readonly MuxDriverKind[] = ['tmux', 'misao'];

export type MuxDriverAvailability = { available: true } | { available: false; reason: MuxDriverUnavailableReason };

/** What a driver probe looks at. `type` is optional: callers that only know the kind skip type-dependent probe checks. */
export type MuxProbeTarget = Partial<Pick<ServerConfig, 'type'>>;

/** A server as the registry sees it: its default mux kind plus the probe target fields. */
export type MuxServerRef = Pick<ServerConfig, 'defaultMux'> & MuxProbeTarget;

/** Evaluated last by `availabilityFor()`; lets a driver report a runtime condition (remote server, daemon down). */
export type MuxDriverProbe = (server: MuxProbeTarget) => MuxDriverAvailability;

export class MuxDriverRegistry {
  private drivers = new Map<MuxDriverKind, { driver: IMuxClient; probe?: MuxDriverProbe }>();
  private routing = new Map<MuxDriverKind, RoutingMuxClient>();
  private unavailableState: RoutingUnavailableState = new Map();

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

  /**
   * The kinds a server can serve, its default kind first. The default is always listed (a failure of it must surface);
   * any other kind only while its driver is registered and available for the server (a local server with a reachable
   * misao daemon serves both; an agent/ssh server serves tmux only).
   */
  usableKinds(server: MuxServerRef): MuxDriverKind[] {
    const others = MUX_DRIVER_KINDS.filter((kind) => kind !== server.defaultMux && this.availabilityFor(kind, server).available);
    return [server.defaultMux, ...others];
  }

  /** Whether the server can use a mux at all: its default driver is available, or another kind is. */
  availability(server: MuxServerRef): MuxDriverAvailability {
    const defaultAvailability = this.availabilityFor(server.defaultMux, server);
    if (defaultAvailability.available) return defaultAvailability;
    const usable = this.usableKinds(server).some((kind) => kind !== server.defaultMux);
    return usable ? { available: true } : defaultAvailability;
  }

  /**
   * The routing driver for a server: each call goes to the tmux or misao driver that owns its argument, and
   * server-wide calls cover every usable kind. Its `kind` is the server's default mux.
   * Throws `MuxDriverUnavailableError` when the server can use no mux at all (see `availability`).
   */
  resolve(server: MuxServerRef): RoutingMuxClient {
    const availability = this.availability(server);
    if (!availability.available) throw new MuxDriverUnavailableError(server.defaultMux, availability.reason);
    const kind = server.defaultMux;
    let routing = this.routing.get(kind);
    if (!routing) {
      routing = new RoutingMuxClient({
        driver: (k) => {
          const entry = this.drivers.get(k);
          if (!entry) throw new MuxDriverUnavailableError(k, 'driver_not_registered');
          return entry.driver;
        },
        resolveKind: (k, srv) => this.resolveKind(k, srv),
        usableKinds: (srv) => this.usableKinds(srv),
      }, kind, this.unavailableState);
      this.routing.set(kind, routing);
    }
    return routing;
  }
}
