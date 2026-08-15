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
// The data dir a canary was (or should be) written into — kept so a
// re-verification failure (see getVerifiedHubCanary below) can attempt a
// fresh write without the route layer having to re-resolve/pass the path
// again per request (Resolve at the Boundary: dataDir itself is still only
// ever resolved once, at startup, by main.ts's writeHubCanary call).
let knownDataDir: string | null = null;

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
  knownDataDir = dataDir;
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

/** In-memory accessor — returns whatever the last successful write (or
 * re-verification) produced, WITHOUT touching the filesystem. Exists only
 * for callers that must stay synchronous; the isolation doctor route itself
 * must use `getVerifiedHubCanary()` below, never this. */
export function getHubCanary(): HubCanary | null {
  return current;
}

/**
 * Review round (Important finding 2): `getHubCanary()` used to be the ONLY
 * accessor, which returns whatever was cached at startup even if the file
 * has since been deleted (its own content literally invites deletion — "this
 * file is safe to ignore or delete") or the data dir was recreated. A
 * same-filesystem agent server would then read back "absent" not because it
 * is isolated but because the canary itself is gone, and the FS-boundary
 * check would misread that as `canaryReadable: false` — i.e. proof of
 * separation — when it proves nothing. This performs a fresh local
 * existence+content check immediately before each doctor run and
 * regenerates on mismatch; only a canary that verifiably exists on disk
 * right now is handed to the doctor. If neither the existing file nor a
 * fresh write can be confirmed, returns `null` so the FS-boundary check
 * degrades to `'unknown'` (fail-closed) instead of silently trusting a
 * stale in-memory value.
 */
export function getVerifiedHubCanary(): HubCanary | null {
  if (current && isCanaryIntact(current)) return current;
  // Cached value is missing/deleted/mismatched (or never wrote successfully)
  // — try to (re)write a fresh one into the same data directory before
  // giving up.
  if (knownDataDir) {
    const rewritten = writeHubCanary(knownDataDir);
    if (rewritten && isCanaryIntact(rewritten)) return rewritten;
  }
  current = null;
  return null;
}

function isCanaryIntact(canary: HubCanary): boolean {
  try {
    return fs.readFileSync(canary.path, 'utf-8') === canary.content;
  } catch {
    return false;
  }
}
