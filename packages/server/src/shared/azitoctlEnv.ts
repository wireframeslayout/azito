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
    .filter(f => /^azitoctl(?:-.+)?\.env$/.test(f))
    .map(f => path.join(dir, f));
}
