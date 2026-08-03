import * as fs from 'fs';
import * as path from 'path';
import type { UnitType } from './UnitType';
import { parseUnitTypeToml } from './unitTypeSchema';

import { resolveRoot } from '../../shared/releaseInfo';

export const DEFAULT_BUILTIN_UNIT_TYPES_DIR = path.join(resolveRoot(), 'harness', 'unit-types');
export const DEFAULT_USER_UNIT_TYPES_DIR = process.env.AZITO_UNIT_TYPES_DIR
  ? path.resolve(process.env.AZITO_UNIT_TYPES_DIR)
  : path.join(resolveRoot(), 'data', 'unit-types');

interface DirListCacheEntry {
  mtime: number;
  files: string[];
}

const dirListCache = new Map<string, DirListCacheEntry>();

function listTomlFiles(rootDir: string): string[] {
  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(rootDir);
  } catch {
    dirListCache.delete(rootDir);
    return [];
  }

  const cached = dirListCache.get(rootDir);
  if (cached && cached.mtime === rootStat.mtimeMs) {
    return cached.files;
  }

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.toml'))
    .map((e) => e.name)
    .sort();
  dirListCache.set(rootDir, { mtime: rootStat.mtimeMs, files });
  return files;
}

interface FileCacheEntry {
  mtime: number;
  unitType: UnitType;
}

const fileCache = new Map<string, FileCacheEntry>();

function readTomlFile(filePath: string): UnitType | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    fileCache.delete(filePath);
    return null;
  }

  const cached = fileCache.get(filePath);
  if (cached && cached.mtime === stat.mtimeMs) {
    return cached.unitType;
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const unitType = parseUnitTypeToml(raw);
  fileCache.set(filePath, { mtime: stat.mtimeMs, unitType });
  return unitType;
}

function loadLayer(rootDir: string): UnitType[] {
  const files = listTomlFiles(rootDir);
  const unitTypes: UnitType[] = [];

  for (const fileName of files) {
    const filePath = path.join(rootDir, fileName);
    try {
      const unitType = readTomlFile(filePath);
      if (!unitType) continue;
      const expectedName = fileName.replace(/\.toml$/, '');
      if (unitType.name !== expectedName) {
        console.warn(`[unit-types] Name mismatch: TOML name "${unitType.name}" does not match file name "${fileName}". Skipping.`);
        continue;
      }
      unitTypes.push(unitType);
    } catch (err) {
      console.warn(`[unit-types] Failed to parse ${filePath}: ${(err as Error).message}. Skipping.`);
    }
  }

  return unitTypes;
}

export class UnitTypeLoader {
  constructor(
    private readonly builtinDir: string = DEFAULT_BUILTIN_UNIT_TYPES_DIR,
    private readonly userDir: string = DEFAULT_USER_UNIT_TYPES_DIR,
  ) {}

  invalidateCache(): void {
    dirListCache.clear();
    fileCache.clear();
  }

  list(): UnitType[] {
    const builtin = loadLayer(this.builtinDir);
    const user = loadLayer(this.userDir);
    const userNames = new Set(user.map((u) => u.name));

    const merged: UnitType[] = [
      ...builtin.filter((u) => !userNames.has(u.name)),
      ...user,
    ];

    return merged.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): UnitType | undefined {
    return this.list().find((u) => u.name === name);
  }

  getOrThrow(name: string): UnitType {
    const unitType = this.get(name);
    if (!unitType) {
      throw new Error(`UnitType "${name}" not found`);
    }
    return unitType;
  }
}
