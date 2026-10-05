/** How the hub sees the mux driver of one server (GET /api/servers/:name `mux`). */
export type MuxDriverStatus = 'ok' | 'unreachable' | 'incompatible' | 'notInstalled' | 'unknown';

/**
 * Interprets the detail API's `mux` field. Anything that is not a well-formed description
 * is 'unknown' (no notice is shown), never read as healthy or as broken.
 */
export function parseMuxDriverStatus(mux: unknown): MuxDriverStatus {
  if (!mux || typeof mux !== 'object' || Array.isArray(mux)) return 'unknown';
  const { driverAvailable, reason } = mux as { driverAvailable?: unknown; reason?: unknown };
  if (driverAvailable === true) return 'ok';
  if (driverAvailable !== false) return 'unknown';
  if (reason === 'daemon_unreachable') return 'unreachable';
  if (reason === 'protocol_incompatible') return 'incompatible';
  if (reason === 'not_installed') return 'notInstalled';
  return 'unknown';
}
