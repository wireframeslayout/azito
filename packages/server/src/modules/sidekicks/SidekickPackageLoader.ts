import * as fs from 'fs';
import * as path from 'path';
import { parseFrontmatter } from './frontmatterParser';
import {
  isValidSidekickName,
  isValidSidekickTag,
  legacyPhaseFieldToTags,
  SIDEKICK_NAME_PATTERN,
  type SidekickLayer,
  type SidekickPackage,
} from './SidekickPackage';

// ─── 層のパス解決（起動時に一度だけ解決し、以降は解決済みパスを使う = Resolve at the Boundary） ───
//
// ビルトイン層: <repo-root>/harness/sidekicks/ （PromptModuleLoader の DEFAULT_MODULES_DIR と同じ方式）
// ユーザー層  : <repo-root>/data/sidekicks/ （環境変数 AZITO_SIDEKICKS_DIR で上書き可）

import { resolveRoot } from '../../shared/releaseInfo';

export const DEFAULT_BUILTIN_SIDEKICKS_DIR = path.join(resolveRoot(), 'harness', 'sidekicks');
export const DEFAULT_USER_SIDEKICKS_DIR = process.env.AZITO_SIDEKICKS_DIR
  ? path.resolve(process.env.AZITO_SIDEKICKS_DIR)
  : path.join(resolveRoot(), 'data', 'sidekicks');

// ─── ディレクトリ一覧キャッシュ（層ルートの mtime で判定） ───

interface DirListCacheEntry {
  mtime: number;
  subdirs: string[];
}

const dirListCache = new Map<string, DirListCacheEntry>();

function listSubdirs(rootDir: string): string[] {
  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(rootDir);
  } catch {
    dirListCache.delete(rootDir);
    return [];
  }

  const cached = dirListCache.get(rootDir);
  if (cached && cached.mtime === rootStat.mtimeMs) {
    return cached.subdirs;
  }

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  // Dirent.isDirectory() は symlink に対して false を返すため、層ルート直下に置かれた
  // symlink はパッケージとして扱われない（層外への symlink 追従を防ぐ）。
  const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  dirListCache.set(rootDir, { mtime: rootStat.mtimeMs, subdirs });
  return subdirs;
}

// ─── SKILL.md 内容キャッシュ（ファイル単位の mtime で判定。ディレクトリ mtime は新規/削除の検知にしか
//     使えず、内容編集では更新されないため、編集検知には個々のファイルの mtime を使う） ───

interface SkillFileCacheEntry {
  mtime: number;
  parsed: ReturnType<typeof parseFrontmatter>;
}

const skillFileCache = new Map<string, SkillFileCacheEntry>();

function readSkillFile(skillPath: string): ReturnType<typeof parseFrontmatter> | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(skillPath);
  } catch {
    skillFileCache.delete(skillPath);
    return null;
  }

  const cached = skillFileCache.get(skillPath);
  if (cached && cached.mtime === stat.mtimeMs) {
    return cached.parsed;
  }

  const raw = fs.readFileSync(skillPath, 'utf-8');
  const parsed = parseFrontmatter(raw);
  skillFileCache.set(skillPath, { mtime: stat.mtimeMs, parsed });
  return parsed;
}

/**
 * frontmatter から tags を解決する。
 * - `tags: a, b` 形式（カンマ区切り）が優先。空文字は「タグ無し」= tags: []。
 * - `tags` が無く旧 `phase` フィールドがある場合は legacyPhaseFieldToTags で変換する
 *   （phase: standalone → tags: []、phase: <5フェーズ> → tags: [<phase>]）。
 * - どちらも無ければ tags: []（タグ無しの汎用スキルとして許容する）。
 * 不正なタグ形式・不正な旧 phase 値の場合は例外を投げる（呼び出し側でパッケージを無効化する）。
 */
function resolveTags(frontmatter: Record<string, string>): string[] {
  if (frontmatter.tags !== undefined) {
    const tags = frontmatter.tags
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    for (const tag of tags) {
      if (!isValidSidekickTag(tag)) {
        throw new Error(`Invalid tag "${tag}" (must match ${SIDEKICK_NAME_PATTERN})`);
      }
    }
    return tags;
  }
  if (frontmatter.phase !== undefined) {
    return legacyPhaseFieldToTags(frontmatter.phase);
  }
  return [];
}

function dirHasEntries(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function loadLayer(rootDir: string, layer: SidekickLayer): SidekickPackage[] {
  const subdirs = listSubdirs(rootDir);
  const packages: SidekickPackage[] = [];

  for (const name of subdirs) {
    const dir = path.join(rootDir, name);
    const skillPath = path.join(dir, 'SKILL.md');

    let parsed: ReturnType<typeof parseFrontmatter> | null;
    try {
      parsed = readSkillFile(skillPath);
    } catch (err) {
      console.warn(`[sidekicks] Failed to parse ${skillPath}: ${(err as Error).message}. Disabling this package.`);
      continue;
    }
    if (!parsed) {
      console.warn(`[sidekicks] ${dir} has no SKILL.md. Disabling this package.`);
      continue;
    }

    const { frontmatter, body } = parsed;
    const fmName = frontmatter.name;
    if (!fmName || fmName !== name) {
      console.warn(
        `[sidekicks] Package name mismatch: frontmatter name "${fmName ?? ''}" does not match directory name "${name}" (${skillPath}). Disabling this package.`,
      );
      continue;
    }
    if (!isValidSidekickName(fmName)) {
      console.warn(`[sidekicks] Invalid package name "${fmName}" (${skillPath}). Disabling this package.`);
      continue;
    }
    let tags: string[];
    try {
      tags = resolveTags(frontmatter);
    } catch (err) {
      console.warn(`[sidekicks] ${(err as Error).message} for package "${fmName}" (${skillPath}). Disabling this package.`);
      continue;
    }

    packages.push({
      name: fmName,
      description: frontmatter.description ?? '',
      tags,
      isDefault: frontmatter.isDefault === 'true',
      layer,
      overridesBuiltin: false, // merge 時に list() が上書きする
      dir,
      body,
      hasScripts: dirHasEntries(path.join(dir, 'scripts')),
      hasReferences: dirHasEntries(path.join(dir, 'references')),
    });
  }

  return packages;
}

/**
 * ビルトイン層とユーザー層をマージして SidekickPackage の一覧を提供する2層ローダー。
 * 同名パッケージはユーザー層が勝つ（overridesBuiltin: true が付く）。
 */
export class SidekickPackageLoader {
  constructor(
    private readonly builtinDir: string = DEFAULT_BUILTIN_SIDEKICKS_DIR,
    private readonly userDir: string = DEFAULT_USER_SIDEKICKS_DIR,
  ) {}

  /**
   * mtime ベースのキャッシュは、同一ミリ秒内に発生した書き込み（例: サービスが連続して
   * ファイルを書く CRUD 操作）までは検知できない場合がある。書き込みを行った側
   * （SidekickPackageService）は、書き込み直後に呼び出して自分自身の変更を確実に
   * 反映させる。
   */
  invalidateCache(): void {
    dirListCache.clear();
    skillFileCache.clear();
  }

  list(): SidekickPackage[] {
    const builtin = loadLayer(this.builtinDir, 'builtin');
    const user = loadLayer(this.userDir, 'user');
    const userNames = new Set(user.map((p) => p.name));
    const builtinNames = new Set(builtin.map((p) => p.name));

    const merged: SidekickPackage[] = [
      ...builtin.filter((p) => !userNames.has(p.name)),
      ...user.map((p) => ({ ...p, overridesBuiltin: builtinNames.has(p.name) })),
    ];

    return merged.sort((a, b) => a.name.localeCompare(b.name));
  }

  findByName(name: string): SidekickPackage | null {
    return this.list().find((p) => p.name === name) ?? null;
  }

  /**
   * あるタグのデフォルトパッケージを解決する（そのタグを持ち isDefault: true のもの）。
   * 複数存在する場合はユーザー層を優先し、それでも複数あれば name 昇順の先頭を採用して警告を出す。
   */
  findDefaultForTag(tag: string): SidekickPackage | null {
    const candidates = this.list().filter((p) => p.tags.includes(tag) && p.isDefault);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const userCandidates = candidates.filter((c) => c.layer === 'user');
    const pool = userCandidates.length > 0 ? userCandidates : candidates;
    const sorted = [...pool].sort((a, b) => a.name.localeCompare(b.name));
    console.warn(
      `[sidekicks] Multiple default packages for tag "${tag}": ${candidates.map((c) => c.name).join(', ')}. Using "${sorted[0].name}".`,
    );
    return sorted[0];
  }
}
