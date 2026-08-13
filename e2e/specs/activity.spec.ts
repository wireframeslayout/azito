// 稼働検知（Issue #338 の統一是正 P1〜P5）の主要フローを、LLM を一切起動せずに検証する。
//
// 判定源の作り分け:
//  - Tier 0 … tui-supervisor の dist バンドルで偽エージェントを包んで起動する。偽エージェントは
//             実 Claude Code と同じ OSC 2 タイトル（`◐ ` = working / `✳ ` = idle）を出すだけで、
//             supervisor の TitleStateTracker がそれを読んでハブへ active/idle を送る。
//  - Tier 4 … タイトルも出力も出さない偽エージェント（`--silent`）を素の tmux ウィンドウで起動し、
//             ペイン分類（Tier 2）を 'unknown' に落としたうえで、セッション JSONL フィクスチャの
//             末尾エントリだけで working / completed / interrupted を作る。
//
// UI 側は「アクティブウィンドウ」パネル（ActiveWindowsSection）を唯一の観測点にする。稼働行・完了行の
// ライフサイクルはすべて `agent:activity` WS イベント経由でここに現れるため、API を直接叩かずに
// エンドツーエンドの経路（監視 → WS → フロントの状態 → 描画）をまとめて検証できる。

import { test, expect, Harness } from '../fixtures/test';
import { sleep } from '../fixtures/harness';
import { createTranscriptFixture } from '../fixtures/transcript';
import type { Locator, Page } from '@playwright/test';

/** Tier 0 の稼働化に許す最大遅延（supervisor の 1 秒ティック + ハブの即時 tick + WS 配信）。 */
const REALTIME_BUDGET_MS = 3_000;

const TMUX_SESSION = 'e2e';

/** 「アクティブウィンドウ」パネル本体。ヘッダーボタンの親要素がパネルのコンテナ。 */
function activeWindowsPanel(page: Page): Locator {
  return page.getByRole('button', { name: /アクティブウィンドウ/ }).locator('xpath=..');
}

/** パネル内の、指定ラベルのウィンドウ行。 */
function windowRow(page: Page, label: string): Locator {
  return activeWindowsPanel(page).locator('.row-hover').filter({ hasText: label });
}

/** 稼働中として描画されている行（`aw-row-working` は working 状態でのみ付く）。 */
function workingRow(page: Page, label: string): Locator {
  return activeWindowsPanel(page).locator('.aw-row-working').filter({ hasText: label });
}

/** 完了行（`完了 · <相対時刻>`）。 */
function finishedRow(page: Page, label: string): Locator {
  return windowRow(page, label).filter({ hasText: '完了 ·' });
}

async function openWorkspace(page: Page, harness: Harness): Promise<void> {
  await page.goto(harness.baseUrl);
  await expect(page.getByRole('button', { name: /アクティブウィンドウ/ })).toBeVisible();
}

test.describe('稼働検知', () => {
  let projectId: number;

  test.beforeAll(async ({ harness }) => {
    projectId = await harness.createProject('E2E 稼働検知');
  });

  test('Tier 0: supervisor 付きエージェントの稼働化と完了行の生成', async ({ app, harness }) => {
    const label = 'e2e-tier0';
    const agent = await harness.startFakeAgent(TMUX_SESSION, 'tier0', { supervised: true });
    await harness.registerAgentWindow(projectId, agent.target, { label });
    await openWorkspace(app, harness);

    // 起動直後（idle タイトル）は稼働していない。
    await expect(windowRow(app, label)).toHaveCount(0);

    agent.setState('working');
    await expect(workingRow(app, label)).toBeVisible({ timeout: REALTIME_BUDGET_MS });

    agent.setState('idle');
    // 消灯（稼働行が消える）と完了行の生成は同じ `running:false, reason:'completed'` 遷移から起きる。
    await expect(workingRow(app, label)).toHaveCount(0, { timeout: REALTIME_BUDGET_MS });
    await expect(finishedRow(app, label)).toBeVisible({ timeout: REALTIME_BUDGET_MS });
  });

  test('上位 Tier の idle を下位 Tier が上書きしない（完了後に transcript を新鮮に保っても再点灯しない）', async ({ app, harness }) => {
    const label = 'e2e-no-override';
    const fixture = createTranscriptFixture(harness.claudeConfigDir, '-e2e-no-override');
    const agent = await harness.startFakeAgent(TMUX_SESSION, 'nooverride', { supervised: true });
    await harness.registerAgentWindow(projectId, agent.target, { label, agentSessionId: fixture.sessionId });
    await openWorkspace(app, harness);

    agent.setState('working');
    await expect(workingRow(app, label)).toBeVisible({ timeout: REALTIME_BUDGET_MS });
    agent.setState('idle');
    await expect(finishedRow(app, label)).toBeVisible({ timeout: REALTIME_BUDGET_MS });

    // Tier 4 単体なら 'working' と答える transcript を、10秒にわたり新鮮なまま維持する。
    // Tier 0 が idle を主張している間、この下位判定は稼働表示を復活させてはならない。
    const observeUntil = Date.now() + 10_000;
    while (Date.now() < observeUntil) {
      fixture.write('in_progress');
      await sleep(1_000);
      await expect(workingRow(app, label)).toHaveCount(0);
    }
    // 完了行も消えていない（再稼働扱いされていれば完了行は落ちる）。
    await expect(finishedRow(app, label)).toBeVisible();
  });

  test('リスポーン直後: housekeeping のみのセッションでは稼働も完了も出ない', async ({ app, harness }) => {
    const label = 'e2e-respawn';
    const fixture = createTranscriptFixture(harness.claudeConfigDir, '-e2e-respawn');
    const agent = await harness.startFakeAgent(TMUX_SESSION, 'respawn', { supervised: false });
    // `claude --resume` 直後の状態: mtime は新しいが、意味あるエントリが1件も無い。
    fixture.write('housekeeping_only');
    await harness.registerAgentWindow(projectId, agent.target, { label, agentSessionId: fixture.sessionId });
    await openWorkspace(app, harness);

    // Tier 4 のプローブが数周する間、mtime を更新し続けても点灯しない。一瞬だけ点いて消える
    // （その後 reason 次第で行が残らない）取りこぼしを防ぐため、観測中も毎秒アサートする。
    const observeUntil = Date.now() + 10_000;
    while (Date.now() < observeUntil) {
      fixture.write('housekeeping_only');
      await sleep(1_000);
      await expect(windowRow(app, label)).toHaveCount(0);
    }
  });

  test('中断で終わったセッションは完了行を作らない', async ({ app, harness }) => {
    // Tier 4 が working を取り下げたあとも、Tier 3（tmux window_activity の鮮度ヒューリスティック）が
    // ACTIVITY_THRESHOLD_SEC = 30 秒はウィンドウを点灯させ続ける。これは判定ロジックそのものの定数
    // （AZITO_E2E_FAST_INTERVALS の短縮対象は観測周期だけで、判定閾値は動かさない）なので、
    // このテストだけは 30 秒の経過を待つ前提でタイムアウトを広げる。
    test.setTimeout(150_000);
    const label = 'e2e-interrupted';
    const fixture = createTranscriptFixture(harness.claudeConfigDir, '-e2e-interrupted');
    const agent = await harness.startFakeAgent(TMUX_SESSION, 'interrupted', { supervised: false });
    fixture.write('in_progress');
    await harness.registerAgentWindow(projectId, agent.target, { label, agentSessionId: fixture.sessionId });
    await openWorkspace(app, harness);

    // まず Tier 4 で稼働させる（working → 非working の遷移を確実に観測させるため）。
    await expect(workingRow(app, label)).toBeVisible({ timeout: 20_000 });

    // 停止ボタン相当: 末尾が中断マーカーになる。reason は 'interrupted' で 'completed' ではない。
    fixture.write('interrupted');
    await expect(workingRow(app, label)).toHaveCount(0, { timeout: 60_000 });
    // 完了行が作られないことを、Tier 4 が数周する余裕をとって確認する。
    await sleep(8_000);
    await expect(finishedRow(app, label)).toHaveCount(0);
    await expect(windowRow(app, label)).toHaveCount(0);
  });

  test('ウィンドウ削除で完了行が消える', async ({ app, harness }) => {
    const label = 'e2e-delete';
    const agent = await harness.startFakeAgent(TMUX_SESSION, 'delete', { supervised: true });
    const windowId = await harness.registerAgentWindow(projectId, agent.target, { label });
    await openWorkspace(app, harness);

    agent.setState('working');
    await expect(workingRow(app, label)).toBeVisible({ timeout: REALTIME_BUDGET_MS });
    agent.setState('idle');
    await expect(finishedRow(app, label)).toBeVisible({ timeout: REALTIME_BUDGET_MS });

    await harness.deleteWindow(windowId);
    await expect(windowRow(app, label)).toHaveCount(0, { timeout: 20_000 });
  });
});
