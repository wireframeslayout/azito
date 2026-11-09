import { test, expect } from '../fixtures/test';

test('registered window opens in the maximize dialog and closes with its shortcut', async ({ app, harness }) => {
  const project = await harness.createProject('maximize-e2e');
  const agent = await harness.startFakeAgent('maximize-e2e', 'agent', { supervised: false });
  const id = await harness.registerAgentWindow(project, agent.target, { label: 'maximize-e2e-window' });
  await app.goto(`${harness.baseUrl}/workspace/${project}`);
  await app.getByRole('button', { name: '検索', exact: true }).click();
  const search = app.getByRole('combobox', { name: '検索' });
  await search.fill(`W-${id}`);
  await expect(app.getByRole('option', { name: new RegExp(`W-${id}`) })).toBeVisible();
  await search.press('Enter');
  await expect(app.locator('.xterm').first()).toBeVisible();
  await app.keyboard.press('Control+Shift+M');
  const dialog = app.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`#${id}`);
  await expect(dialog.locator('.xterm')).toBeVisible();
  await app.keyboard.press('Control+Shift+M');
  await expect(dialog).toHaveCount(0);
});
