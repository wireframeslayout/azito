import fs from 'fs';
import path from 'path';
import { isReleaseMode, resolveRoot } from './releaseInfo';

export function readEnvValue(filePath: string, key: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;

  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const k = trimmed.slice(0, eqIndex).trim();
    if (k !== key) continue;

    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

export function resolveServerEnvPath(): string {
  if (isReleaseMode()) {
    return path.join(resolveRoot(), '.env');
  }
  return path.join(resolveRoot(), 'packages', 'server', '.env');
}
