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
  return fs.readdirSync(dir)
    .filter(f => /^azitoctl(-[^.]+)?\.env$/.test(f))
    .map(f => path.join(dir, f));
}
