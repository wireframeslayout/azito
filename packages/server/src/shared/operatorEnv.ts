import fs from 'fs';
import path from 'path';

export function isOperatorEnvFilename(name: string): boolean {
  return /^operator(?:-.+)?\.env$/.test(name);
}

export function findOperatorEnvFiles(homeDir: string): string[] {
  const dir = path.join(homeDir, '.azito');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(isOperatorEnvFilename).map(f => path.join(dir, f));
}
