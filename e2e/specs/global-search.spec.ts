import { test, expect } from '../fixtures/test';

test('検索パレットでプロジェクトを検索し移動する', async ({ app, harness }) => {
  const projectId = await harness.createProject('global-search-e2e');
  await app.goto(`${harness.baseUrl}/projects`);
  await app.locator('body').click({ position: { x: 5, y: 5 } });
  await app.keyboard.press('Space');
  await app.keyboard.press('Space');
  const search = app.getByRole('combobox', { name: '検索' });
  await expect(search).toBeVisible();
  await search.fill('global-search-e2e');
  await expect(app.getByRole('option', { name: /global-search-e2e/ })).toBeVisible();
  await search.press('Enter');
  await expect(app).toHaveURL(new RegExp(`/workspace/${projectId}`));
});

test('別プロジェクトの窓を検索して開く', async ({ app, harness }) => {
  const first = await harness.createProject('global-search-first');
  const second = await harness.createProject('global-search-second');
  const agent = await harness.startFakeAgent('global-search', 'agent', { supervised: false });
  const windowId = await harness.registerAgentWindow(second, agent.target, { label: 'cross-project-window' });
  await app.goto(`${harness.baseUrl}/workspace/${first}`);
  await app.getByRole('button', { name: '検索', exact: true }).click();
  const search = app.getByRole('combobox', { name: '検索' });
  await search.fill(`W-${windowId}`);
  await expect(app.getByRole('option', { name: new RegExp(`W-${windowId}`) })).toBeVisible();
  await search.press('Enter');
  await expect(app).toHaveURL(new RegExp(`/workspace/${second}`));
});
