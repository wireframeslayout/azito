// ─── SidekickPackage: Claude Skill 型のスキルパッケージ ───
//
// ディレクトリ形式:
//   <layer-root>/<name>/
//     SKILL.md        必須。YAML風 frontmatter + 本文
//     scripts/        任意。実行可能スクリプト
//     references/     任意。参考資料
//
// 本文にはテンプレート変数（{{task.*}} {{project.*}} {{module.*}} {{sidekick.*}} 等）を書けるが、
// scripts/ 配下のファイルの中身は展開しない（renderSidekickBody.ts 参照。インジェクション防止のため、
// スクリプトへ値を渡す場合は呼び出し側が環境変数または引数として渡す規約とする）。

import { isPhaseTag } from './TaskPhase';

export type SidekickLayer = 'builtin' | 'user';

/**
 * パストラバーサル防止のためのパッケージ名形式。API 入力・frontmatter 双方で検証する。
 * タグの形式検証にも同じパターンを使う（Issue #263 Refine A）。
 */
export const SIDEKICK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isValidSidekickName(name: string): boolean {
  return SIDEKICK_NAME_PATTERN.test(name);
}

/** タグは自由語彙だが、name と同じ形式制約を課す（パストラバーサル・表示崩れ防止）。 */
export function isValidSidekickTag(tag: string): boolean {
  return SIDEKICK_NAME_PATTERN.test(tag);
}

/**
 * 旧 `phase: <SidekickPhase>` フィールドの値を新 `tags: string[]` へ変換する（後方互換）。
 * `standalone` は「phase タグを1つも持たない」に対応するため空配列にする。
 * 5フェーズ以外の値（旧仕様の想定外）は不正として扱う。
 */
export function legacyPhaseFieldToTags(phase: string): string[] {
  if (phase === 'standalone') return [];
  if (isPhaseTag(phase)) return [phase];
  throw new Error(`Invalid phase "${phase}"`);
}

export interface SidekickPackage {
  name: string;
  description: string;
  /**
   * 自由語彙のタグ。5つの phase タグ（planning/implementing/reviewing/testing/pushing、
   * TaskPhase.ts の isPhaseTag で判定）は特別扱いで、Unit の phase_config 割当対象を絞る。
   * phase タグを1つも持たない場合、旧 standalone 相当（汎用スキル）となる。
   */
  tags: string[];
  /** 持っている phase タグに対するデフォルト採用か（複数 phase タグを持つ場合は全 phase のデフォルト候補）。 */
  isDefault: boolean;
  /** どちらの層から解決されたか。同名はユーザー層が勝つので、これは「実際に採用された」層。 */
  layer: SidekickLayer;
  /** user 層のパッケージが同名のビルトインを上書きしているか。builtin 層のエントリでは常に false。 */
  overridesBuiltin: boolean;
  /** パッケージディレクトリの絶対パス。 */
  dir: string;
  /** SKILL.md の本文（frontmatter を除く）。 */
  body: string;
  hasScripts: boolean;
  hasReferences: boolean;
}

/** GET /api/sidekicks の一覧表示用（body を含まないメタ情報のみ）。 */
export type SidekickMeta = Omit<SidekickPackage, 'body'>;
