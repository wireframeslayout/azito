import { test, expect } from '../fixtures/test';

test('エージェント窓をオーケストレーターに変換して一覧から解除する', async ({ app, harness }) => {
  const project = await harness.createProject('orchestration-e2e');
  const agent = await harness.startFakeAgent('orchestration-e2e', 'agent', { supervised: false });
  const id = await harness.registerAgentWindow(project, agent.target, { label: 'orchestration-e2e-window' });
  await app.goto(`${harness.baseUrl}/workspace/${project}`);
  await app.getByText(`W-${id}`, { exact: true }).first().click({ button: 'right' });
  await app.getByText('オーケストレーションに移動', { exact: true }).click();
  await app.getByRole('button', { name: '開く', exact: true }).click();
  await expect(app).toHaveURL(new RegExp(`/orchestration/${id}$`));
  await expect(app.getByRole('treeitem')).toHaveCount(1);
  await app.getByRole('button', { name: 'オーケストレーターの役割を解除' }).click();
  await expect.poll(async () => (await harness.api<Array<{ id: number }>>('/orchestrators')).some((window) => window.id === id)).toBe(false);
  await app.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect.poll(async () => (await harness.api<Array<{ id: number }>>('/orchestrators')).some((window) => window.id === id)).toBe(true);
});
