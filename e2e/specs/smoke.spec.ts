// 基本導線のスモーク: UI トークンでログイン → プロジェクト作成 → ウィンドウ登録 →
// オブジェクト一覧に現れる、までを実 UI で通す。
//
// このスペックだけはトークンを sessionStorage へ先入れせず、TokenGate を実際に通す
// （認証導線そのものが検証対象のため）。

import { test, expect } from '../fixtures/test';

test('ログイン → プロジェクト作成 → ウィンドウ登録 → オブジェクト一覧', async ({ page, harness }) => {
  await page.addInitScript(() => {
    localStorage.setItem('azito-language', 'ja');
  });

  // ── ログイン（TokenGate） ──
  await page.goto(harness.baseUrl);
  const tokenInput = page.getByPlaceholder('AZITO_UI_TOKEN');
  await expect(tokenInput).toBeVisible();
  await tokenInput.fill(harness.uiToken);
  await page.getByRole('button', { name: '接続' }).click();
  await expect(tokenInput).toHaveCount(0);

  // ── プロジェクト作成（実フォーム） ──
  const projectName = 'e2e-smoke-project';
  await page.goto(`${harness.baseUrl}/projects/new`);
  await page.getByPlaceholder('プロジェクト名').fill(projectName);
  await page.getByPlaceholder('project-slug').fill(projectName);
  await page.getByRole('button', { name: 'プロジェクトを作成' }).click();
  // 作成が成功するとプロジェクト一覧へ戻る（失敗時はフォームに留まってエラーが出る）。
  await expect(page).toHaveURL(/\/projects$/);

  const projects = await harness.api<Array<{ id: number; name: string }>>('/projects');
  const project = projects.find((p) => p.name === projectName);
  expect(project).toBeDefined();

  // ── ウィンドウ登録 ──
  // 実 tmux ウィンドウが要るので、隔離 tmux 上に偽エージェントを立ててから登録する。
  const agent = await harness.startFakeAgent('smoke', 'agent', { supervised: false });
  await harness.registerAgentWindow(project!.id, agent.target, { label: 'e2e-smoke-window' });

  // ── オブジェクト一覧に現れる ──
  await page.goto(`${harness.baseUrl}/workspace/${project!.id}`);
  await expect(page.getByRole('button', { name: /オブジェクト/ }).first()).toBeVisible();

  // 一覧は稼働中/待機中/オフラインの状態別セクションに分かれ、どこに入るかは登録直後の
  // 判定タイミング次第。折りたたまれているセクションを開いてから探す。
  for (const section of ['稼働中', '待機中', 'オフライン']) {
    const header = page.getByRole('button', { name: new RegExp(`^${section} \\d+$`) });
    await expect(header).toBeVisible({ timeout: 20_000 });
    if (await header.getAttribute('aria-expanded') === 'false') await header.click();
  }
  await expect(page.getByText('e2e-smoke-window').first()).toBeVisible({ timeout: 20_000 });

  // ── ステータスバーの稼働検知パネル ──
  // 表示資格（diagnosticsEnabled）はサーバー判定で、E2E ハブはソースコード版なので有効。
  // supervisor 付きで起動して Tier 0 の稼働行を作り、パネルにその行が出ることまで見る。
  const supervised = await harness.startFakeAgent('smoke-diag', 'agent', { supervised: true });
  supervised.setState('working');
  await harness.registerAgentWindow(project!.id, supervised.target, { label: 'e2e-diag-window' });

  await page.getByRole('button', { name: '稼働検知' }).click();
  await expect(page.getByRole('button', { name: supervised.target })).toBeVisible({ timeout: 20_000 });
});
