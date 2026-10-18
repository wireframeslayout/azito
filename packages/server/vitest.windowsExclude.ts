/**
 * Windows の CI（`Unit tests (Windows)`）でまだ通らない unit テストファイル。
 * ファイル名は変えずに、ここで外して理由を書く。Windows 対応（#379 以降の P2〜P9、#369〜#372）が進むたびに減らす。
 * vitest.config.ts は Windows のときだけ unit プロジェクトの exclude にこれを足す（Linux / macOS には影響しない）。
 */
export interface WindowsExcludeEntry {
  /** packages/server からの相対パス（スラッシュ区切り）。 */
  file: string;
  reason: string;
}

export const WINDOWS_EXCLUDED_UNIT_TESTS: readonly WindowsExcludeEntry[] = [];
