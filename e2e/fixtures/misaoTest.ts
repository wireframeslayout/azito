// misao ドライバ用の Playwright `test`。既存の fixtures/test.ts を土台に、worker スコープの
// `harness` だけを差し替える: 一時ソケットで自前の misao デーモンを立て、そこへ繋ぐハブ
// （AZITO_EXPERIMENTAL_MISAO=1）を起動する。`app` / 後片付けの auto fixture は test.ts のものをそのまま使う。
//
// 既存の tmux 系 spec は fixtures/test.ts を import し続けるので、この差し替えの影響を受けない。

import { test as base, Harness } from './test';
import { MisaoDaemon } from './misaoDaemon';

export { Harness };

interface MisaoWorkerFixtures {
  misaoDaemon: MisaoDaemon;
}

export const test = base.extend<object, MisaoWorkerFixtures>({
  misaoDaemon: [
    async ({}, use) => {
      const daemon = await MisaoDaemon.start();
      try {
        await use(daemon);
      } finally {
        await daemon.stop();
      }
    },
    { scope: 'worker', timeout: 60_000 },
  ],

  harness: [
    async ({ misaoDaemon }, use) => {
      const harness = await Harness.start({ misaoSocket: misaoDaemon.socketPath });
      try {
        await use(harness);
      } finally {
        await harness.stop();
      }
    },
    { scope: 'worker', timeout: 120_000 },
  ],
});

export { expect } from './test';
export { MisaoDaemon } from './misaoDaemon';
