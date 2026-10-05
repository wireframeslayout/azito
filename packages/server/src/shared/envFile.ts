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

/**
 * Sets `KEY=value` in an env file: replaces the existing assignment in place, otherwise appends one (creating the
 * file with mode 600 when it does not exist). Other lines, comments included, are kept as they are.
 */
export function upsertEnvValue(filePath: string, key: string, value: string): void {
  const line = `${key}=${value}`;
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${line}\n`, { mode: 0o600 });
    return;
  }
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  const index = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
  if (index >= 0) {
    lines[index] = line;
  } else {
    // the last element is '' when the file ends with a newline: keep that ending
    if (lines[lines.length - 1] === '') lines.pop();
    lines.push(line, '');
  }
  fs.writeFileSync(filePath, lines.join('\n'));
}

export function resolveServerEnvPath(): string {
  if (isReleaseMode()) {
    return path.join(resolveRoot(), '.env');
  }
  return path.join(resolveRoot(), 'packages', 'server', '.env');
}
