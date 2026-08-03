import type Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

export const version = 41;
export const description = 'Rewrite user-layer Sidekick SKILL.md frontmatter from legacy phase: to tags: (Issue #263 Refine A)';

// packages/server/src/shared/db/migrations → migrations → db → shared → src → server → packages → repo root
const USER_SIDEKICKS_DIR = process.env.AZITO_SIDEKICKS_DIR
  ? path.resolve(process.env.AZITO_SIDEKICKS_DIR)
  : path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'data', 'sidekicks');

const FIVE_PHASES = ['planning', 'implementing', 'reviewing', 'testing', 'pushing'];

/**
 * 旧 `phase: <value>` を新 `tags: <value>` へ変換する。standalone は空タグ、5フェーズはそのタグ1つ。
 * 想定外の値（旧仕様にも無い不正値）は null を返し、呼び出し側でそのファイルをスキップさせる
 * （フォールバックで握りつぶさず、書き換え対象から除外するだけに留める）。
 */
function legacyPhaseValueToTags(phase: string): string[] | null {
  if (phase === 'standalone') return [];
  if (FIVE_PHASES.includes(phase)) return [phase];
  return null;
}

/**
 * SKILL.md の frontmatter ブロック（先頭 `---` 〜 次の `---`）の行範囲を返す。
 * frontmatter が無い/終端されていないファイルは対象外として null を返す（039 と同じく防御的スキップ）。
 * modules/sidekicks/frontmatterParser.ts と同じ規約（フラット key: value）を前提にするが、
 * マイグレーションは将来のモジュール変更から独立させるためあえて再実装する（039 の EXPECTED_SEED も同様の方針）。
 */
function findFrontmatterBounds(lines: string[]): { start: number; end: number } | null {
  if (lines.length === 0 || lines[0].trim() !== '---') return null;
  const endIdx = lines.findIndex((line, idx) => idx > 0 && line.trim() === '---');
  if (endIdx === -1) return null;
  return { start: 1, end: endIdx };
}

/**
 * 前後を囲う引用符（' または "）を1組だけ剥がす。
 * modules/sidekicks/frontmatterParser.ts の stripQuotes と同じ規約
 * （`phase: "planning"` のような引用符付き値の解釈を loader の互換読みと一致させる）。
 */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * frontmatter ブロック内から key の値を読む（最初に一致した行のみ）。無ければ undefined。
 * frontmatterParser.ts と同様に引用符を1組だけ剥がす。
 */
function readFrontmatterField(lines: string[], start: number, end: number, key: string): string | undefined {
  const prefix = `${key}:`;
  for (let i = start; i < end; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith(prefix)) {
      return stripQuotes(trimmed.slice(prefix.length).trim());
    }
  }
  return undefined;
}

/**
 * 既存ユーザー層 Sidekick パッケージの SKILL.md を、互換読みだけに依存せず新形式へ揃えるための
 * マイグレーション。DB は触らず FS のみを書き換える。036-040 は不変更（実DBに適用済み）。
 *
 * 対象外（no-op）:
 * - ユーザー層ディレクトリが存在しない
 * - パッケージに SKILL.md が無い、または frontmatter が不正で解析できない
 * - 既に `tags:` フィールドを持つ（新形式で作成/編集済み）
 * - `phase:` フィールドも無い（frontmatter に元々 phase が無かった変則ファイル。互換読みは
 *   phase 未指定を tags: [] として扱うため、書き換えなくても壊れない）
 * - `phase:` の値が5フェーズ/standalone 以外の不正値（互換読みでもエラーになるため、
 *   ユーザーに気づかせるべきは維持しつつ、マイグレーション側で勝手に補正はしない）
 */
export function up(_db: Database.Database): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(USER_SIDEKICKS_DIR, { withFileTypes: true });
  } catch {
    return; // ユーザー層ディレクトリが無い: no-op
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(USER_SIDEKICKS_DIR, entry.name, 'SKILL.md');

    let raw: string;
    try {
      raw = fs.readFileSync(skillPath, 'utf-8');
    } catch {
      continue; // SKILL.md が無い: no-op
    }

    const lines = raw.split('\n');
    const bounds = findFrontmatterBounds(lines);
    if (!bounds) {
      console.warn(`[migration 041] ${skillPath}: unterminated or missing frontmatter. Skipping.`);
      continue;
    }
    const { start, end } = bounds;

    if (readFrontmatterField(lines, start, end, 'tags') !== undefined) continue; // 既に新形式
    const phaseValue = readFrontmatterField(lines, start, end, 'phase');
    if (phaseValue === undefined) continue; // phase も無い変則ファイル: 互換読みで tags: [] のまま動くので対象外

    const tags = legacyPhaseValueToTags(phaseValue);
    if (tags === null) {
      console.warn(`[migration 041] ${skillPath}: invalid legacy phase value "${phaseValue}". Skipping.`);
      continue;
    }

    let replaced = false;
    for (let i = start; i < end; i++) {
      if (lines[i].trim().startsWith('phase:')) {
        lines[i] = `tags: ${tags.join(', ')}`;
        replaced = true;
        break;
      }
    }
    if (!replaced) continue; // 到達しないはずだが防御的にスキップ

    // 旧 standalone + isDefault: true の組み合わせは、新仕様では不変条件違反になる
    // （isDefault は phase タグを最低1つ要求 = assertDefaultHasPhaseTag）。このまま残すと
    // 一覧で Default 表示されるのにどのフェーズのデフォルトにもならず、以後の PUT が
    // 全て 400 になるため、変換時に isDefault: false へ落とす。
    let demotedDefault = false;
    if (tags.length === 0 && readFrontmatterField(lines, start, end, 'isDefault') === 'true') {
      for (let i = start; i < end; i++) {
        if (lines[i].trim().startsWith('isDefault:')) {
          lines[i] = 'isDefault: false';
          demotedDefault = true;
          break;
        }
      }
    }

    fs.writeFileSync(skillPath, lines.join('\n'), 'utf-8');
    console.log(
      `[migration 041] Rewrote ${skillPath}: phase: ${phaseValue} -> tags: ${tags.join(', ') || '(none)'}`
      + (demotedDefault ? ' (isDefault demoted to false: no phase tag)' : ''),
    );
  }
}
