import type { MuxDriverKind } from '@azito/shared';
import type { IMuxClient } from './IMuxClient';
import type { ServerConfig } from '../servers/Server';
import { MuxDriverUnavailableError, type MuxDriverUnavailableReason } from './MuxCapabilityError';
import { RoutingMuxClient } from './RoutingMuxClient';

const MUX_DRIVER_KINDS: readonly MuxDriverKind[] = ['tmux', 'misao'];

export type MuxDriverAvailability = { available: true } | { available: false; reason: MuxDriverUnavailableReason };

/** What a driver probe looks at. Both are optional: callers that only know the kind skip type/server-dependent probe checks. */
export type MuxProbeTarget = Partial<Pick<ServerConfig, 'type' | 'name'>>;

/** A server as the registry sees it: its default mux kind plus the probe target fields. */
export type MuxServerRef = Pick<ServerConfig, 'defaultMux'> & MuxProbeTarget;

/** Evaluated last by `availabilityFor()`; lets a driver report a runtime condition (daemon down, not installed on that server). */
export type MuxDriverProbe = (server: MuxProbeTarget) => MuxDriverAvailability;

/**
 * Whether a server hosts the kind, for a kind that is not its default: a server that never had it set up (misao on an
 * agent server that has none) does not list it, so it does not show up as `unavailable` on every listing. A kind
 * without this check is listed on every server.
 */
export type MuxDriverHosted = (server: MuxProbeTarget) => boolean;

export class MuxDriverRegistry {
  private drivers = new Map<MuxDriverKind, { driver: IMuxClient; probe?: MuxDriverProbe; hosted?: MuxDriverHosted }>();
  private routing = new Map<MuxDriverKind, RoutingMuxClient>();

  register(kind: MuxDriverKind, driver: IMuxClient, probe?: MuxDriverProbe, hosted?: MuxDriverHosted): void {
    this.drivers.set(kind, { driver, probe, hosted });
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
   * The kinds a server hosts, its default kind first: the default always, another kind when its driver is registered
   * and says the server hosts it (misao: every local server, and an agent server where it was set up). Whether a kind
   * answers right now is `usableKinds`; a supported kind that does not is unavailable, not absent.
   */
  supportedKinds(server: MuxServerRef): MuxDriverKind[] {
    const others = MUX_DRIVER_KINDS.filter((kind) => {
      if (kind === server.defaultMux) return false;
      const entry = this.drivers.get(kind);
      return entry !== undefined && (entry.hosted?.(server) ?? true);
    });
    return [server.defaultMux, ...others];
  }

  /**
   * The supported kinds to call now, default first. The default is always listed (a failure of it must surface);
   * another kind only while its driver is available for the server.
   */
  usableKinds(server: MuxServerRef): MuxDriverKind[] {
    return this.supportedKinds(server).filter((kind) => kind === server.defaultMux || this.availabilityFor(kind, server).available);
  }

  /** The supported non-default kinds that cannot be called now, with the reason (a stopped or incompatible daemon). */
  downKinds(server: MuxServerRef): Array<{ kind: MuxDriverKind; reason: MuxDriverUnavailableReason }> {
    const down: Array<{ kind: MuxDriverKind; reason: MuxDriverUnavailableReason }> = [];
    for (const kind of this.supportedKinds(server)) {
      if (kind === server.defaultMux) continue;
      const availability = this.availabilityFor(kind, server);
      if (!availability.available) down.push({ kind, reason: availability.reason });
    }
    return down;
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
        downKinds: (srv) => this.downKinds(srv),
      }, kind);
      this.routing.set(kind, routing);
    }
    return routing;
  }
}
