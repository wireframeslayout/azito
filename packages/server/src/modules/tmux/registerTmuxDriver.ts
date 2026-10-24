import type { MuxDriverRegistry } from './MuxDriverRegistry';
import type { IMuxClient } from './IMuxClient';
import { hostRunsTmux } from '../servers/muxKinds';

/**
 * Registers the tmux driver. A host without tmux (a Windows hub's local server, a Windows agent) does not host it
 * (`hosted`: not listed) and answers `unsupported_os` when asked, so nothing on it reaches for a tmux that cannot exist.
 */
export function registerTmuxDriver(registry: MuxDriverRegistry, driver: IMuxClient): void {
  registry.register(
    'tmux',
    driver,
    (server) => (hostRunsTmux(server) ? { available: true } : { available: false, reason: 'unsupported_os' }),
    (server) => hostRunsTmux(server),
  );
}
