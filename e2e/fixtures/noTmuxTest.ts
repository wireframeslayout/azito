// 「tmux が入っていないホスト」の Playwright `test`。misaoTest.ts と同じく worker スコープの `harness` を
// 差し替える: PATH から tmux を引けなくした環境で、自前の misao デーモンと、それに繋ぐハブを起動する。
// （リリース版は tmux 無しでインストールできる。その状態で窓とタスクが misao だけで動くことを検証する。）
//
// 隔離は misaoTest.ts と同じ（一時ソケット・一時データ・空きポート。常駐の ~/.misao には繋がない）。
// tmux 系の既存 spec は fixtures/test.ts を import し続けるので、この差し替えの影響を受けない。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test as base, Harness } from './test';
import { MisaoDaemon } from './misaoDaemon';
import { assertNoTmux, pathWithoutTmux } from './tmuxlessPath';

export { Harness };

interface NoTmuxWorkerFixtures {
  /** ホストの PATH から tmux だけを引けなくしたもの。 */
  tmuxlessPath: string;
  misaoDaemon: MisaoDaemon;
}

export const test = base.extend<object, NoTmuxWorkerFixtures>({
  tmuxlessPath: [
    async ({}, use) => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-e2e-notmux-'));
      try {
        const searchPath = pathWithoutTmux(process.env.PATH ?? '', workDir);
        assertNoTmux(searchPath);
        await use(searchPath);
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    },
    { scope: 'worker' },
  ],

  misaoDaemon: [
    async ({ tmuxlessPath }, use) => {
      const daemon = await MisaoDaemon.start({ path: tmuxlessPath });
      try {
        await use(daemon);
      } finally {
        await daemon.stop();
      }
    },
    { scope: 'worker', timeout: 60_000 },
  ],

  harness: [
    async ({ misaoDaemon, tmuxlessPath }, use) => {
      const harness = await Harness.start({ misaoSocket: misaoDaemon.socketPath, path: tmuxlessPath });
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
