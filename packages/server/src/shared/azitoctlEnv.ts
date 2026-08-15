import fs from 'fs';
import path from 'path';

// ─── azitoctl*.env file discovery ───
//
// Shared by `azito token rotate` (packages/server/src/cli/tokenCommand.ts)
// and `azito auth doctor` (packages/server/src/cli/authDoctorCommand.ts) —
// both need to enumerate every `~/.azito/azitoctl*.env` file written by
// harness/setup.sh (one per --prefix). Kept as a single function so the
// glob pattern only needs to match harness/setup.sh's naming scheme
// (`azitoctl${prefix ? '-' + prefix : ''}.env`) in one place.

/**
 * Pure filename-matching predicate, factored out of `findAzitoctlEnvFiles`
 * below (Issue #29 Step 2 B) so the isolation doctor's remote probe (which
 * lists `~/.azito/` on an AGENT server through `IServerTransport.exec`, not
 * this process's local `fs`) can reuse the exact same discovery grammar
 * without importing anything that touches the local filesystem. See that
 * function's own comment for why `.+` (not `[^.]+`) is required.
 */
export function isAzitoctlEnvFilename(name: string): boolean {
  return /^azitoctl(?:-.+)?\.env$/.test(name);
}

/**
 * Pure content predicate — "does this azitoctl*.env file's content carry a
 * live AZITO_UI_TOKEN=... line". Factored out for the same remote-reuse
 * reason as `isAzitoctlEnvFilename` above: the isolation doctor `cat`s each
 * candidate file's content over a transport and must apply the identical
 * test `checkAzitoctlEnvNoUiToken` (authDoctorCommand.ts) applies locally.
 */
export function hasUiTokenLine(content: string): boolean {
  return /^AZITO_UI_TOKEN=/m.test(content);
}

export function findAzitoctlEnvFiles(): string[] {
  const dir = path.join(process.env.HOME || '', '.azito');
  if (!fs.existsSync(dir)) return [];
  // `--prefix` accepts any string harness/setup.sh's caller passes (no
  // charset restriction there — see its `--prefix`/`--prefix=*` parsing),
  // so a prefix like `prod.eu` is legitimate and produces
  // `azitoctl-prod.eu.env`. The old `[^.]+` prefix group rejected any dot in
  // the prefix, so that file was silently skipped by both `azito auth
  // doctor` and `azito token rotate` — a doctor run against a dotted-prefix
  // environment could report "all checks passed" while a stale UI token
  // lingered in a file it never looked at (Phase C fix). `.+` is
  // intentionally unrestricted (matches whatever setup.sh can produce); the
  // trailing `\.env$` anchor still requires the LAST `.env` to be the
  // extension, so greedy backtracking still finds the right split even
  // when the prefix itself contains ".env"-like substrings.
  return fs.readdirSync(dir)
    .filter(isAzitoctlEnvFilename)
    .map(f => path.join(dir, f));
}
