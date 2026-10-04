// misao ドライバの主要導線を、LLM を一切起動せずに検証する。
//
// 構成: 一時ソケットで自前の misao デーモンを起動し（fixtures/misaoDaemon.ts）、そこへ繋ぐハブ
// （MISAO_SOCKET で一時デーモンを指す）を立てる（fixtures/misaoTest.ts）。常駐デーモンや tmux の
// 既定ソケットには触れない。シナリオは前のシナリオの状態（既定のターミナル方式の切替・登録した窓）に
// 依存するため直列で流し、最後に「デーモン断」を検証する。
//
// misao のビルド成果物（MISAO_CLI、既定 ~/workspace/misao/packages/cli/dist/main.js）が無い環境では
// 理由付きで skip する。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect, MisaoDaemon } from '../fixtures/misaoTest';
import type { Harness } from '../fixtures/misaoTest';

test.skip(
  MisaoDaemon.cliPath() === null,
  'misao CLI が見つからない（misao をビルドして MISAO_CLI=<misao>/packages/cli/dist/main.js を指定する）',
);
test.describe.configure({ mode: 'serial' });

const NO_SUBAGENT = { enabled: false, provider: '', model: '' };
const TASK_AGENT_PATH = path.join(__dirname, '..', 'fixtures', 'fake-agent', 'task-agent');

/** pane.state イベント → Tier 0（tier0_mux）→ WS → 描画までに許す最大遅延。 */
const REALTIME_BUDGET_MS = 10_000;
/** タスク実行（窓作成 → コマンド送出 → プロンプト往復 → 完了検知）に許す最大時間。 */
const TASK_BUDGET_MS = 60_000;

function activeWindowsPanel(page: Page): Locator {
  return page.getByRole('button', { name: /アクティブウィンドウ/ }).locator('xpath=..');
}

/**
 * 行は misao のペインタイトルを表示名にするため（登録ラベルではなく `W-<窓ID> · <タイトル>`）、
 * 窓行 ID の `W-<id>` で特定する。
 */
function windowTag(windowId: number): RegExp {
  return new RegExp(`W-${windowId}(?!\\d)`);
}

function workingRow(page: Page, windowId: number): Locator {
  return activeWindowsPanel(page).locator('.aw-row-working').filter({ hasText: windowTag(windowId) });
}

function finishedRow(page: Page, windowId: number): Locator {
  return activeWindowsPanel(page).locator('.row-hover').filter({ hasText: windowTag(windowId) }).filter({ hasText: '完了 ·' });
}

interface ServerDetail {
  defaultMux: string;
  muxRuntime: string;
  mux: { runtime: string; kind: string; driverAvailable: boolean; reason?: string };
}

interface DebugActivityRow {
  windowId?: number;
  decidedBy?: string;
  state?: string;
}

test.describe('misao ドライバ', () => {
  let projectId: number;

  test.beforeAll(async ({ harness }) => {
    projectId = await harness.createProject('E2E misao');
  });

  test('設定: local サーバーの既定のターミナル方式を misao へ切り替えられる', async ({ app, harness }) => {
    await app.goto(`${harness.baseUrl}/servers/local`);
    await app.getByRole('button', { name: /編集/ }).click();
    // local の編集フォームは 2 項目だけ（接続情報の欄は出ない）: 既定のターミナル方式と tmux の実行ファイル。
    // （Modal は dialog ロールを持たず label も select に紐付かないため、option で特定する。）
    const defaultMuxSelect = app.locator('select', { has: app.locator('option[value="misao"]') });
    await expect(defaultMuxSelect.locator('option')).toHaveText(['misao', 'tmux']);
    const runtimeSelect = app.locator('select', { has: app.locator('option[value="managed"]') });
    await expect(runtimeSelect.locator('option')).toHaveText(['システム', '管理版']);
    await defaultMuxSelect.selectOption('misao');
    await expect(app.getByText(/ターミナル方式を misao デーモンへ切り替えます/)).toBeVisible();
    await app.getByRole('button', { name: '保存' }).click();

    // 概要に既定のターミナル方式と接続状態が出る。接続できているので「接続できません」は出ない。
    await expect(app.getByText('既定のターミナル方式')).toBeVisible();
    await expect(app.getByText('接続中', { exact: true })).toBeVisible();
    await expect(app.getByText(/misao に接続できません/)).toHaveCount(0);

    const detail = await harness.api<ServerDetail>('/servers/local');
    expect(detail.defaultMux).toBe('misao');
    expect(detail.muxRuntime).toBe('system');
    expect(detail.mux).toMatchObject({ kind: 'misao', driverAvailable: true });
  });

  test('窓作成: misao のウィンドウを作成・登録できる', async ({ harness }) => {
    const { windowId } = await createRegisteredWindow(harness, projectId, 'create');

    const windows = await harness.api<Array<{ id: number; muxRef?: { kind: string } }>>(`/projects/${projectId}/windows`);
    expect(windows.find((w) => w.id === windowId)?.muxRef?.kind).toBe('misao');
  });

  test('窓作成: 1 台のサーバーに kind を指定して tmux の窓と misao の窓を並べて作れる（#312）', async ({ harness }) => {
    interface Created { ok: boolean; ref: string }
    const create = (kind: string, name: string): Promise<Created> => harness.api<Created>('/servers/local/mux/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name, windowName: 'main', kind }),
    });
    // 既定は misao（前のシナリオで切り替え済み）。kind=tmux を指定した窓だけが tmux に作られる。
    const tmuxWin = await create('tmux', 'e2e-kind-tmux');
    const misaoWin = await create('misao', 'e2e-kind-misao');
    expect(JSON.parse(tmuxWin.ref).kind).toBe('tmux');
    expect(JSON.parse(misaoWin.ref).kind).toBe('misao');

    const listing = await harness.api<{ sessions: Array<{ name: string; kind: string }>; unavailable: unknown[] }>('/servers/local/sessions?detail=1');
    expect(listing.unavailable).toEqual([]);
    expect(listing.sessions.filter((s) => s.name.startsWith('e2e-kind-')).map((s) => [s.name, s.kind]).sort())
      .toEqual([['e2e-kind-misao', 'misao'], ['e2e-kind-tmux', 'tmux']]);

    // 種別として不正な値は 400（使えない kind の 409 は、サーバーの単体テストで理由まで確認している）。
    await expect(harness.api('/servers/local/mux/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'e2e-kind-bad', kind: 'zellij' }),
    })).rejects.toThrow(/400.*Invalid kind/);
  });

  test('端末 attach: ブラウザ端末への入力が misao のペインへ届き、出力が返る', async ({ app, harness }) => {
    const { label } = await createRegisteredWindow(harness, projectId, 'attach');

    await app.goto(`${harness.baseUrl}/workspace/${projectId}`);
    // 起動中のエージェントが無い窓は「オフライン」に入る。折りたたまれているので開いてから探す。
    const offline = app.getByRole('button', { name: /^オフライン \d+$/ });
    await expect(offline).toBeVisible();
    if ((await offline.getAttribute('aria-expanded')) === 'false') await offline.click();
    await app.getByText(label).first().click();
    const xterm = app.locator('.xterm').first();
    await expect(xterm).toBeVisible();
    await xterm.click();
    // 算術展開にして、入力のエコーではなく「実行された出力」だけが一致するようにする。
    await app.keyboard.type('echo e2e-misao-$((40+2))\n');
    await expect(app.locator('.xterm-rows').first()).toContainText('e2e-misao-42', { timeout: 15_000 });
  });

  test('タスク実行: tmux の窓と並ぶ misao の窓で、scripted fake がプロンプトに従って完了し、タスクが review になる', async ({ harness }) => {
    const repo = createGitRepo();
    try {
      // 同じ local サーバーに tmux の窓を置いておく（#311: 1 台で tmux と misao の窓を併用する）。
      // 既定のターミナル方式は misao なので、名前ベースの tmux セッションルートで tmux 側に作る。
      const tmuxSession = 'e2e-mixed-tmux';
      const createdTmux = await harness.api<{ ok: boolean; windowName: string }>('/servers/local/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: tmuxSession, windowName: 'side' }),
      });
      expect(createdTmux.ok).toBe(true);

      await harness.api(`/projects/${projectId}/servers/local`, {
        method: 'PUT',
        body: JSON.stringify({ working_directory: repo }),
      });
      const phaseConfig = Object.fromEntries(
        ['planning', 'reviewing', 'testing', 'pushing'].map((phase) => [phase, { enabled: false }]),
      );
      const { id: unitId } = await harness.api<{ id: number }>('/units', {
        method: 'POST',
        body: JSON.stringify({
          name: 'e2e-misao-unit',
          worker_type: 'generic',
          worker_extra_args: `${shellQuote(process.execPath)} ${shellQuote(TASK_AGENT_PATH)}`,
          phase_config: phaseConfig,
          // POST /api/units は省略された subagent 設定を JSON の "null" として保存し、読み戻しで
          // 失敗する（既存の不具合）。明示的に「無効」を渡して避ける。
          review_subagent: NO_SUBAGENT,
          implement_subagent: NO_SUBAGENT,
        }),
      });
      const { id: taskId } = await harness.api<{ id: number }>('/tasks', {
        method: 'POST',
        body: JSON.stringify({
          project_id: projectId,
          unit_id: unitId,
          server_name: 'local',
          title: 'e2e misao task',
          description: 'e2e: scripted fake agent completes this task',
          base_branch: 'main',
          skip_pr: true,
          require_plan_approval: false,
        }),
      });

      await harness.api(`/units/${unitId}/execute`, { method: 'POST', body: JSON.stringify({ taskId, force: true }) });

      await expect.poll(async () => (await harness.api<{ status: string }>(`/tasks/${taskId}`)).status, {
        timeout: TASK_BUDGET_MS,
      }).toBe('review');

      // タスクの窓は misao に作られ、tmux の窓はそのまま並んでいる。一覧は両方を kind 付きで返す。
      const taskWindows = await harness.api<Array<{ isPrimary: boolean; muxRef?: { kind: string } }>>(`/tasks/${taskId}/windows`);
      expect(taskWindows.find((w) => w.isPrimary)?.muxRef?.kind).toBe('misao');
      const listing = await harness.api<{ sessions: Array<{ name: string; kind: string }>; unavailable: unknown[] }>('/servers/local/sessions?detail=1');
      expect(listing.unavailable).toEqual([]);
      expect(listing.sessions).toContainEqual(expect.objectContaining({ name: tmuxSession, kind: 'tmux' }));
      expect(listing.sessions.some((s) => s.kind === 'misao')).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('稼働検知: pane.state イベントが稼働行と完了行になる', async ({ app, harness, misaoDaemon }) => {
    const label = 'e2e-misao-agent';
    const stateFile = path.join(harness.dataDir, 'misao-agent.state');
    fs.writeFileSync(stateFile, 'idle');
    const win = await misaoDaemon.openWindow('e2e-misao-agent', 'agent', [
      process.execPath, harness.fakeAgentPath, '--busy', stateFile,
    ]);
    const windowId = await harness.registerMisaoWindow(projectId, win, { label });

    await app.goto(harness.baseUrl);
    await expect(app.getByRole('button', { name: /アクティブウィンドウ/ })).toBeVisible();
    await expect(workingRow(app, windowId)).toHaveCount(0);

    fs.writeFileSync(stateFile, 'working');
    await expect(workingRow(app, windowId)).toBeVisible({ timeout: REALTIME_BUDGET_MS });
    // 判定源は misao の pane.state（Tier 0 の mux 経路）であること。
    const rows = await harness.api<DebugActivityRow[]>('/debug/activity');
    expect(rows.find((r) => r.windowId === windowId)?.decidedBy).toBe('tier0_mux');

    // idle: 稼働行は消える。misao の idle は完了の証拠ではない（reason は unknown）ので完了行は作らない
    // （docs/ja/activity-detection.md §13。完了として扱うのはプロセス終了＝ pane.state の exited だけ）。
    fs.writeFileSync(stateFile, 'idle');
    await expect(workingRow(app, windowId)).toHaveCount(0, { timeout: REALTIME_BUDGET_MS });
    await expect(finishedRow(app, windowId)).toHaveCount(0);

    // 稼働中にプロセスが終了すると（exited → done）、稼働行が完了行へ変わる。
    fs.writeFileSync(stateFile, 'working');
    await expect(workingRow(app, windowId)).toBeVisible({ timeout: REALTIME_BUDGET_MS });
    fs.writeFileSync(stateFile, 'exit');
    await expect(workingRow(app, windowId)).toHaveCount(0, { timeout: REALTIME_BUDGET_MS });
    await expect(finishedRow(app, windowId)).toBeVisible({ timeout: REALTIME_BUDGET_MS });
  });

  test('デーモン断: 概要に「misao に接続できません」が出る', async ({ app, harness, misaoDaemon }) => {
    // 記録した PID にだけ SIGTERM を送る。ディレクトリはワーカー終了時の stop() が消す。
    await misaoDaemon.stopProcess();
    await expect.poll(async () => (await harness.api<ServerDetail>('/servers/local')).mux.reason, { timeout: 30_000 })
      .toBe('daemon_unreachable');

    await app.goto(`${harness.baseUrl}/servers/local`);
    await expect(app.getByText('misao に接続できません。端末からは misao status で確認できます')).toBeVisible();
    await expect(app.getByText('接続不可', { exact: true })).toBeVisible();
    // 利用者が気づけるよう、通知は status ロールで読み上げられる。
    await expect(app.getByRole('status').filter({ hasText: /misao に接続できません/ })).toBeVisible();
  });
});

/** ハブ経由で misao の窓を作り、プロジェクトへ登録する（窓行はテストごとの後片付けで消える）。 */
async function createRegisteredWindow(
  harness: Harness,
  projectId: number,
  name: string,
): Promise<{ windowId: number; label: string }> {
  const label = `e2e-misao-${name}`;
  const created = await harness.api<{ ref: string; windowName: string }>('/servers/local/mux/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name: label, windowName: name }),
  });
  const windowId = await harness.registerMisaoWindow(
    projectId,
    { ref: created.ref },
    { label },
  );
  return { windowId, label };
}

function createGitRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-e2e-repo-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'e2e@example.invalid');
  git('config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(repo, 'README.md'), 'e2e\n');
  git('add', '.');
  git('commit', '-m', 'init');
  return repo;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
