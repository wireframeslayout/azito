// 「tmux が入っていないホスト」で、misao だけで窓とタスクが動くことを、LLM を一切起動せずに検証する。
//
// リリース版は tmux 無しでインストールできる（misao 同梱・tmux は任意）。その状態を再現するため、PATH から
// tmux だけを引けなくした環境で、自前の misao デーモンと、それに繋ぐハブを立てる（fixtures/noTmuxTest.ts）。
// 常駐デーモンや tmux の既定ソケットには触れない。シナリオは前のシナリオの状態（既定のターミナル方式・
// 作った窓）に依存するため直列で流す。
//
// misao のビルド成果物（MISAO_CLI、既定 ~/workspace/misao/packages/cli/dist/main.js）が無い環境では
// 理由付きで skip する。

import fs from 'node:fs';
import { test, expect, MisaoDaemon } from '../fixtures/noTmuxTest';
import { createGitRepo, runScriptedTaskToReview } from '../fixtures/scriptedTask';

test.skip(
  MisaoDaemon.cliPath() === null,
  'misao CLI が見つからない（misao をビルドして MISAO_CLI=<misao>/packages/cli/dist/main.js を指定する）',
);
test.describe.configure({ mode: 'serial' });

interface MuxStatus {
  status: string;
  message?: string;
  mux: Record<string, { available: boolean; version?: string; detail?: string }>;
}

interface SessionListing {
  sessions: Array<{ name: string; kind: string }>;
  unavailable: Array<{ kind: string; reason: string }>;
}

test.describe('tmux なし', () => {
  let projectId: number;

  test.beforeAll(async ({ harness }) => {
    projectId = await harness.createProject('E2E no tmux');
  });

  test('前提: ハブの PATH に tmux は無く、ハブは起動して local サーバーを misao 既定にできる', async ({ harness }) => {
    await expect(harness.tmux(['-V'])).rejects.toMatchObject({ code: 'ENOENT' });

    await harness.api('/servers/local', { method: 'PUT', body: JSON.stringify({ defaultMux: 'misao' }) });

    const detail = await harness.api<{ defaultMux: string; mux: { kind: string; driverAvailable: boolean } }>('/servers/local');
    expect(detail.defaultMux).toBe('misao');
    expect(detail.mux).toMatchObject({ kind: 'misao', driverAvailable: true });
  });

  test('状態: /status は mux ごとに返り、tmux が無くても既定の misao が使えればサーバーは問題なし', async ({ harness }) => {
    const status = await harness.api<MuxStatus>('/servers/local/status');

    expect(status.status).toBe('online');
    expect(status.mux.misao?.available).toBe(true);
    expect(status.mux.tmux).toMatchObject({ available: false });
    expect(status.message).toBeUndefined();
  });

  test('設定: セットアップで tmux は「任意」、misao は導入済みと表示される', async ({ app, harness }) => {
    await app.goto(`${harness.baseUrl}/servers/local/setup`);

    const tmuxRow = app.locator('div', { has: app.getByText('tmux', { exact: true }) }).filter({ has: app.getByText('任意', { exact: true }) }).last();
    await expect(tmuxRow).toBeVisible();
    await expect(app.getByText(/tmux の窓を使う場合だけ必要です/)).toBeVisible();
    // 任意の tmux が無いことは、セットアップの「未導入」件数に数えない。
    await expect(app.getByText(/^未導入 \d+$/)).toHaveCount(0);

    await expect(app.getByText('misao', { exact: true })).toBeVisible();
    // ソース版のハブは misao サービスを入れない（リリース版の同梱・更新操作はここに出る）。
    await expect(app.getByText(/ソース版のハブはサービスを入れません/)).toBeVisible();
  });

  test('窓作成: kind 未指定は misao に作られ、tmux は理由付きで使えない', async ({ harness }) => {
    const created = await harness.api<{ ref: string }>('/servers/local/mux/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'e2e-notmux', windowName: 'main' }),
    });
    expect(JSON.parse(created.ref).kind).toBe('misao');

    await expect(harness.api('/servers/local/mux/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'e2e-notmux-tmux', windowName: 'main', kind: 'tmux' }),
    })).rejects.toThrow(/409.*mux_kind_unavailable.*binary_missing/);

    const listing = await harness.api<SessionListing>('/servers/local/sessions?detail=1');
    expect(listing.unavailable).toContainEqual(expect.objectContaining({ kind: 'tmux', reason: 'binary_missing' }));
    expect(listing.sessions).toContainEqual(expect.objectContaining({ name: 'e2e-notmux', kind: 'misao' }));
  });

  test('窓の追加: ターミナル方式の選択で tmux は disabled になり、理由が出る', async ({ app, harness }) => {
    await app.goto(`${harness.baseUrl}/projects/${projectId}`);
    await app.getByRole('button', { name: 'ウィンドウを追加' }).first().click();

    const kindTabs = app.getByRole('tablist', { name: 'ターミナル方式' });
    await expect(kindTabs).toBeVisible();
    await expect(kindTabs.getByRole('tab', { name: 'tmux' })).toBeDisabled();
    await expect(kindTabs.getByRole('tab', { name: 'misao' })).toHaveAttribute('aria-selected', 'true');
    await expect(app.getByText('tmux: tmux が入っていません')).toBeVisible();
  });

  test('タスク実行: misao の窓だけで scripted fake がプロンプトに従って完了し、タスクが review になる', async ({ harness }) => {
    const repo = createGitRepo();
    try {
      const taskId = await runScriptedTaskToReview(harness, projectId, repo, { unit: 'e2e-notmux-unit', title: 'e2e no tmux task' });

      const taskWindows = await harness.api<Array<{ isPrimary: boolean; muxRef?: { kind: string } }>>(`/tasks/${taskId}/windows`);
      expect(taskWindows.find((w) => w.isPrimary)?.muxRef?.kind).toBe('misao');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
