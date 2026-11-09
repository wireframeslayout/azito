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
  await app.setViewportSize({ width: 320, height: 800 });
  await app.goto(`${harness.baseUrl}/workspace/${project}`);
  await app.getByRole('button', { name: 'メニュー', exact: true }).click();
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
