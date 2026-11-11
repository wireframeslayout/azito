import { test, expect } from '../fixtures/test';

test('エージェント窓をオーケストレーターに変換して一覧から解除する', async ({ app, harness }) => {
  const project = await harness.createProject('orchestration-e2e');
  const agent = await harness.startFakeAgent('orchestration-e2e', 'agent', { supervised: false });
  const id = await harness.registerAgentWindow(project, agent.target, { label: 'orchestration-e2e-window' });
  await app.goto(`${harness.baseUrl}/workspace/${project}`);
  await app.getByText(`W-${id}`, { exact: true }).first().click({ button: 'right' });
  await app.getByText('オーケストレーションに移動', { exact: true }).click();
  await expect(app.getByRole('button', { name: /オーケストレーター 1 件はレールから/ })).toBeVisible();
  await app.getByRole('button', { name: '開く', exact: true }).click();
  await expect(app).toHaveURL(new RegExp(`/orchestration/${id}$`));
  await expect(app.getByRole('treeitem')).toHaveCount(1);
  await app.getByRole('button', { name: 'オーケストレーション一覧を収納' }).click();
  await app.getByRole('button', { name: 'オーケストレーション', exact: true }).last().click();
  await expect(app.getByRole('menu', { name: 'オーケストレーション' })).toBeVisible();
  await app.getByRole('button', { name: 'オーケストレーション一覧を展開' }).click();
  await app.getByRole('treeitem').first().click({ button: 'right' });
  await app.getByRole('button', { name: /プロジェクトの窓に戻す（元:/ }).click();
  await expect.poll(async () => (await harness.api<Array<{ id: number }>>('/orchestrators')).some((window) => window.id === id)).toBe(false);
  await app.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect.poll(async () => (await harness.api<Array<{ id: number }>>('/orchestrators')).some((window) => window.id === id)).toBe(true);
});

test('スマホのナビシートから一覧を開いて窓を選ぶ', async ({ app, harness }) => {
  const project = await harness.createProject('orchestration-mobile');
  const agent = await harness.startFakeAgent('orchestration-mobile', 'agent', { supervised: false });
  const id = await harness.registerAgentWindow(project, agent.target);
  await harness.api(`/windows/${id}/role`, { method: 'PUT', body: JSON.stringify({ role: 'orchestrator' }) });
  await app.setViewportSize({ width: 320, height: 640 });
  await app.goto(`${harness.baseUrl}/workspace/${project}`);
  await app.getByRole('button', { name: 'メニュー', exact: true }).click();
  const settings = app.getByRole('button', { name: 'AZITO設定', exact: true });
  await settings.scrollIntoViewIfNeeded();
  const settingsBox = await settings.boundingBox();
  const statusBox = await app.getByRole('button', { name: '稼働ステータス', exact: true }).boundingBox();
  expect(settingsBox).not.toBeNull();
  expect(statusBox).not.toBeNull();
  expect(settingsBox!.y + settingsBox!.height).toBeLessThanOrEqual(statusBox!.y);
  await app.getByRole('button', { name: /オーケストレーション/ }).click();
  await app.getByRole('treeitem').click();
  await expect(app).toHaveURL(new RegExp(`/orchestration/${id}$`));
  await expect(app.getByRole('button', { name: 'オーケストレーション一覧を収納' })).toHaveCount(0);
  await expect(app.getByRole('dialog', { name: 'ナビゲーションメニュー' })).toHaveCount(0);
  expect(await app.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('空画面からオーケストレーターを作成する', async ({ app, harness }) => {
  await app.goto(`${harness.baseUrl}/orchestration`);
  await app.getByRole('button', { name: 'オーケストレーターを作成', exact: true }).click();
  const dialog = app.getByRole('dialog', { name: 'オーケストレーターを作成' });
  await dialog.getByLabel('作業ディレクトリ').fill(harness.rootDir);
  await dialog.getByRole('button', { name: 'オーケストレーターを作成' }).click();
  await expect(app).toHaveURL(/\/orchestration\/\d+$/);
  const id = Number(new URL(app.url()).pathname.split('/').at(-1));
  await harness.api(`/windows/${id}`, { method: 'DELETE' });
});

test('役割解除のエラーを表示し一覧を維持する', async ({ app, harness }) => {
  const project = await harness.createProject('orchestration-role-error');
  const agent = await harness.startFakeAgent('orchestration-role-error', 'agent', { supervised: false });
  const id = await harness.registerAgentWindow(project, agent.target);
  await harness.api(`/windows/${id}/role`, { method: 'PUT', body: JSON.stringify({ role: 'orchestrator' }) });
  await app.route(`**/api/windows/${id}/role`, (route) => route.fulfill({ status: 409, json: { error: 'conflict' } }));
  await app.goto(`${harness.baseUrl}/orchestration/${id}`);
  await app.getByRole('treeitem').first().click({ button: 'right' });
  await app.getByRole('button', { name: /プロジェクトの窓に戻す（元:/ }).click();
  await expect(app.getByText('窓の役割を変更できませんでした')).toBeVisible();
  await expect(app.getByRole('treeitem')).toHaveCount(1);
});

test('作業ディレクトリなしでは作成しない', async ({ app, harness }) => {
  await app.goto(`${harness.baseUrl}/orchestration`);
  await app.getByRole('button', { name: 'オーケストレーターを作成', exact: true }).click();
  const dialog = app.getByRole('dialog', { name: 'オーケストレーターを作成' });
  await dialog.getByRole('button', { name: 'オーケストレーターを作成' }).click();
  await expect(app.getByText('サーバーと作業ディレクトリを指定してください')).toBeVisible();
  await expect(dialog).toBeVisible();
});

test('連携した窓を右パネルから解除して元に戻す', async ({ app, harness }) => {
  const project = await harness.createProject('orchestration-links');
  const sourceAgent = await harness.startFakeAgent('orchestration-links', 'source', { supervised: false });
  const targetAgent = await harness.startFakeAgent('orchestration-links', 'target', { supervised: false });
  const source = await harness.registerAgentWindow(project, sourceAgent.target, { label: 'source' });
  const target = await harness.registerAgentWindow(project, targetAgent.target, { label: 'linked-target' });
  await harness.api(`/windows/${source}/role`, { method: 'PUT', body: JSON.stringify({ role: 'orchestrator' }) });
  await harness.api(`/windows/${source}/links`, { method: 'POST', body: JSON.stringify({ targetWindowId: target }) });
  await app.goto(`${harness.baseUrl}/orchestration/${source}`);
  await app.getByRole('button', { name: '連携中の窓を開く' }).click();
  const panel = app.getByRole('complementary', { name: /連携中/ });
  await expect(panel.getByText('linked-target')).toBeVisible();
  await panel.getByRole('button', { name: '連携を解除' }).click();
  await expect(panel.getByText('linked-target')).not.toBeVisible();
  await panel.getByRole('button', { name: '元に戻す' }).click();
  await expect(panel.getByText('linked-target')).toBeVisible();
});

test('自動連携したタスクを要対応順に表示する', async ({ app, harness }) => {
  const project = await harness.createProject('orchestration-auto');
  const agent = await harness.startFakeAgent('orchestration-auto', 'source', { supervised: false });
  const source = await harness.registerAgentWindow(project, agent.target, { label: 'auto-source' });
  await harness.api(`/windows/${source}/role`, { method: 'PUT', body: JSON.stringify({ role: 'orchestrator' }) });
  const create = (title: string) => harness.api<{ id: number }>('/tasks', { method: 'POST', headers: { 'X-Azito-Window-Id': `W-${source}` }, body: JSON.stringify({ project_id: project, title }) });
  await create('通常タスク');
  const attention = await create('要対応タスク');
  await harness.api(`/tasks/${attention.id}`, { method: 'PUT', body: JSON.stringify({ status: 'waiting_input' }) });
  await app.goto(`${harness.baseUrl}/orchestration/${source}`);
  await app.getByRole('button', { name: '連携中の窓を開く' }).click();
  const panel = app.getByRole('complementary', { name: /連携中/ });
  await expect(panel.getByText('要対応タスク', { exact: true })).toBeVisible();
  const cards = panel.locator('article');
  await expect(cards.first()).toContainText('要対応タスク');
  await expect(cards.nth(1)).toContainText('通常タスク');
  await panel.getByRole('tab', { name: /要対応/ }).click();
  await expect(panel.getByText('通常タスク')).not.toBeVisible();
});
