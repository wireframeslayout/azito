// Playwright の `test` を AZITO 用に拡張したもの。
//
// - `harness`: worker スコープ。1ワーカーにつきハブを1インスタンスだけ立てる（起動に数秒かかるため
//   テストごとの再起動は避ける）。テスト同士は tmux セッション名・ウィンドウ名・ウィンドウ行を
//   分けることで干渉しない。
// - `app`: test スコープ。UI トークン投入・言語固定を済ませた `page` を返す。
//
// 認証は sessionStorage の `azito_ui_token`（TokenGate が読む唯一の場所）へ addInitScript で
// 直接入れる。ログイン画面そのものの検証はスモークスペックが実トークン入力で別途行う。

import { test as base, type Page } from '@playwright/test';
import { Harness } from './harness';

interface WorkerFixtures {
  harness: Harness;
}

interface TestFixtures {
  app: Page;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  harness: [
    async ({}, use) => {
      const harness = await Harness.start();
      try {
        await use(harness);
      } finally {
        await harness.stop();
      }
    },
    { scope: 'worker', timeout: 120_000 },
  ],

  app: async ({ page, harness }, use) => {
    await seedBrowserState(page, harness);
    await use(page);
  },
});

/**
 * UI トークン（sessionStorage）と言語（localStorage、既定の言語自動判定を止めて日本語に固定）を
 * ページ読み込み前に入れる。`active-windows-*` はテスト間で状態が漏れないよう明示的に消す。
 */
async function seedBrowserState(page: Page, harness: Harness): Promise<void> {
  await page.addInitScript(([token]) => {
    sessionStorage.setItem('azito_ui_token', token);
    localStorage.setItem('azito-language', 'ja');
    localStorage.removeItem('active-windows-finished');
    localStorage.setItem('active-windows-collapsed', '0');
  }, [harness.uiToken]);
}

export { expect } from '@playwright/test';
export { Harness } from './harness';
