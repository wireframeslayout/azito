/**
 * E2E 専用の周期短縮スイッチ。
 *
 * 稼働検知（AgentActivityMonitor の Tier 4 / WindowActivityStatusService）の周期は本番では
 * 十数秒〜1分オーダーで、E2E がその1周期を待つとテスト時間がスイート全体で数分規模に膨らみ、
 * 待ち時間ぎりぎりのアサーションが flake の温床になる。`AZITO_E2E_FAST_INTERVALS=1` を
 * **サーバープロセスの環境変数として** 与えたときだけ短縮値を使う。
 *
 * 未設定（および '1' 以外の値）のときは本番値をそのまま返すため、本番挙動には一切影響しない。
 * 短縮するのは「同じ判定をどれだけ速く見に行くか」だけで、判定ロジック自体は変えない。
 */
export function resolveInterval(productionMs: number, fastMs: number): number {
  return process.env.AZITO_E2E_FAST_INTERVALS === '1' ? fastMs : productionMs;
}
