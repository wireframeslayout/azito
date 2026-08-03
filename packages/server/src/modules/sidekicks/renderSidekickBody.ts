import { expandPromptTemplate } from '../prompt/promptTemplate';
import type { SidekickPackage } from './SidekickPackage';

/**
 * SidekickPackage の SKILL.md 本文にテンプレート変数を展開する薄いラッパー。
 * 既存の expandPromptTemplate をそのまま使い、`sidekick.dir` / `sidekick.name` を vars に追加する。
 *
 * 重要（インジェクション防止の規約）: scripts/ 配下のスクリプトファイルの中身には
 * このテンプレート展開を適用してはならない。スクリプトへ値を渡す場合は、呼び出し側
 * （本文の指示に従うエージェント）が環境変数または引数としてスクリプト実行時に渡す。
 * 本文の展開結果をスクリプトへ文字列注入すると、タスク入力（title/description等）経由の
 * コマンドインジェクション経路になるため、これを禁止する。
 */
/**
 * @param dirOverride Overrides `{{sidekick.dir}}` for a specific execution
 *   server (Issue #263 Phase 6: local execution uses `pkg.dir` as-is;
 *   ssh/agent execution passes the synced remote path instead, resolved via
 *   sidekicks/SidekickSyncService.resolveSidekickDir). Omit to keep the
 *   package's own `dir` (e.g. the standalone/local-only render paths).
 */
export function renderSidekickBody(
  pkg: Pick<SidekickPackage, 'dir' | 'name' | 'body'>,
  vars: Record<string, Record<string, string>>,
  keepUnknown = false,
  dirOverride?: string,
): string {
  const mergedVars: Record<string, Record<string, string>> = {
    ...vars,
    sidekick: { dir: dirOverride ?? pkg.dir, name: pkg.name },
  };
  return expandPromptTemplate(pkg.body, mergedVars, keepUnknown);
}
