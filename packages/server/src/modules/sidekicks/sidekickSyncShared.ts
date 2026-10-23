import type { IServerTransport } from '../servers/transport/ServerTransport';

// Remote placement mirrors the existing `~/.azito/<thing>` convention used by
// HarnessInstaller (`~/.azito/harness`) and AgentInstaller (`~/.azito/agent`).
// Packages land flat under this base (`<base>/<name>/`) — the builtin/user
// layer split is a hub-local concept only; the merge already happened before
// this service ever sees the package list.
export const REMOTE_SIDEKICKS_BASE = '~/.azito/sidekicks';
export const HASH_FILENAME = '.azito-sidekicks-hash';

/** A lock older than this is considered abandoned (crashed holder) and is taken over. */
export const LOCK_STALE_SECONDS = 300;
export const LOCK_STALE_MS = LOCK_STALE_SECONDS * 1000;

/** What one sync to one server needs, resolved by `SidekickSyncService` before a route (file operations or shell) takes over. */
export interface SidekickSyncContext {
  serverName: string;
  transport: IServerTransport;
  /** Content hash of the package tree; the host's marker file holds the hash it was last synced to. */
  hash: string;
  /** The gzip-compressed tar of the package tree. Built only when a transfer is needed. */
  buildTarball: () => Promise<Buffer>;
  /** Remote lock acquisition attempts before giving up. */
  lockRetries: number;
  /** Delay between lock attempts in ms. */
  lockRetryDelayMs: number;
}
