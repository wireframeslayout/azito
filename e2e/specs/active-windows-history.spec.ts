import { test, expect } from '../fixtures/test';

test('confirmed completion stays in history after opening and reload', async ({ page: app, harness }) => {
  await app.addInitScript((token) => {
    sessionStorage.setItem('azito_ui_token', token);
    localStorage.setItem('azito-language', 'ja');
    localStorage.setItem('active-windows-collapsed', '0');
  }, harness.uiToken);
  const projectId = await harness.createProject('History');
  const agent = await harness.startFakeAgent('e2e', 'history', { supervised: true });
  const windowId = await harness.registerAgentWindow(projectId, agent.target, { label: 'history-test' });
  await app.goto(harness.baseUrl);
  const panel = app.getByRole('button', { name: /アクティブウィンドウ/ }).locator('xpath=..');
  agent.setState('working');
  const row = panel.locator('.row-hover').filter({ hasText: new RegExp(`W-${windowId}(?!\\d)`) });
  await expect(row).toBeVisible();
  agent.setState('idle');
  await expect(row.getByText(/完了 ·/)).toBeVisible();
  await row.getByRole('button').first().click();
  await expect(panel.getByText(/履歴 1 \/ 10/)).toBeVisible();
  await expect.poll(async () => app.evaluate(() => JSON.parse(localStorage.getItem('active-windows-finished') || '[]')[0]?.seenAt)).toBeTruthy();
  await app.reload();
  await expect(panel.getByText(/履歴 1 \/ 10/)).toBeVisible();
});
