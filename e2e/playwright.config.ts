import { defineConfig, devices } from '@playwright/test';

/**
 * AZITO の E2E 設定。
 *
 * - `webServer` は使わない。ハブはテスト側のハーネス（fixtures/harness.ts）が実行ごとに
 *   一時 DATA_DIR・空きポート・隔離 tmux 付きで起動し、baseURL もそこから決まるため。
 * - ブラウザは chromium のみ。稼働検知の検証にブラウザ差は関係しない。
 * - `workers: 1`。1ワーカー = ハブ1インスタンス = 隔離 tmux サーバー1個で、シナリオ間の
 *   干渉を構造的に無くす（並列化してもハブ起動コストが線形に増えるだけで得が無い）。
 *
 * CI 組み込みは意図的に見送っている（ローカル実行のみ）。GitHub Actions ランナーには tmux も
 * Playwright のブラウザも無く、そのセットアップとランタイム予算の検討は本スイートの範囲外なので、
 * 別イシューとして切り出す。
 */
export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    locale: 'ja-JP',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium' }],
});
