import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// ─── Hub FS-boundary canary (Issue #29 isolation doctor review, Critical
// finding 1) ───
//
// The isolation doctor's same-host check previously relied ENTIRELY on
// hostname/uid matching — a signal that says nothing about actual
// filesystem reachability. A container sharing a Docker host's utsname can
// differ on both hostname and uid while still bind-mounting the hub's own
// data directory, which would sail straight through as "isolated" while an
// agent process running there can read (and in principle write) everything
// the hub itself can. This module gives the doctor something to actually
// TEST: a small, non-secret marker file written into the hub's own data
// directory at startup, whose absolute path (and expected content) the
// doctor probes for on the target server via its transport. If the target
// can read it, the target shares the hub's filesystem — full stop,
// regardless of what hostname/uid claim.
//
// Deliberately non-secret: the canary's random suffix and content carry no
// capability and grant nothing if read by a legitimate remote server (the
// whole point is that a genuinely isolated server CAN'T read it) — so a
// write failure at startup is a warning, never a reason to block hub boot.

const CANARY_CONTENT = 'azito-hub-fs-boundary-canary — this file is safe to ignore or delete';

export interface HubCanary {
  path: string;
  content: string;
}

let current: HubCanary | null = null;

/**
 * Writes a fresh canary file directly under the hub's data directory.
 * Best-effort: failure (read-only mount, permissions, etc.) only warns via
 * the returned `null` — callers must not fail hub startup over it. When it
 * fails, the isolation doctor's FS-boundary check has no canary to test and
 * reports `'unknown'` (never a false `'pass'`) for every agent server, which
 * is the correct fail-closed behavior for "we could not even attempt the
 * measurement".
 */
export function writeHubCanary(dataDir: string): HubCanary | null {
  try {
    const suffix = crypto.randomBytes(16).toString('hex');
    const filePath = path.join(dataDir, `.azito-hub-canary-${suffix}`);
    fs.writeFileSync(filePath, CANARY_CONTENT, { mode: 0o600 });
    current = { path: filePath, content: CANARY_CONTENT };
    return current;
  } catch {
    current = null;
    return null;
  }
}

/** In-memory accessor — the canary is resolved once at startup (Resolve at
 * the Boundary) and read by routes.ts when it builds the doctor's
 * `HubIdentity`, never re-written per request. */
export function getHubCanary(): HubCanary | null {
  return current;
}
