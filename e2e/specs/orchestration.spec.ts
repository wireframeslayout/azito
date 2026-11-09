import { test, expect } from '../fixtures/test';

test('エージェント窓をオーケストレーターに変換して一覧から解除する', async ({ app, harness }) => {
  const project = await harness.createProject('orchestration-e2e');
  const agent = await harness.startFakeAgent('orchestration-e2e', 'agent', { supervised: false });
  const id = await harness.registerAgentWindow(project, agent.target, { label: 'orchestration-e2e-window' });
  await app.goto(`${harness.baseUrl}/workspace/${project}`);
  await app.getByText(`W-${id}`, { exact: true }).first().click({ button: 'right' });
  await app.getByText('オーケストレーションに移動', { exact: true }).click();
  await expect(app.getByRole('button', { name: /オーケストレーションに移動しました/ })).toBeVisible();
  await app.getByRole('button', { name: '開く', exact: true }).click();
  await expect(app).toHaveURL(new RegExp(`/orchestration/${id}$`));
  await expect(app.getByRole('treeitem')).toHaveCount(1);
  await app.getByRole('button', { name: 'オーケストレーション一覧を収納' }).click();
  await app.getByRole('button', { name: 'オーケストレーション', exact: true }).last().click();
  await expect(app.getByRole('menu', { name: 'オーケストレーション' })).toBeVisible();
  await app.getByRole('button', { name: 'オーケストレーション一覧を展開' }).click();
  await app.getByRole('button', { name: 'オーケストレーターの役割を解除' }).click();
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
  await app.getByRole('button', { name: 'オーケストレーション', exact: true }).click();
  await app.getByRole('treeitem').getByRole('button', { name: /W-/ }).click();
  await expect(app).toHaveURL(new RegExp(`/orchestration/${id}$`));
  await expect(app.getByRole('dialog', { name: 'ナビゲーションメニュー' })).toHaveCount(0);
  expect(await app.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
