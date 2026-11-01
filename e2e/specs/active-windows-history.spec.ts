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


test('retention limits confirmed rows and mobile layout fits at 320px', async ({ page, harness }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const projectId = await harness.createProject('Mobile history');
  const agent = await harness.startFakeAgent('e2e', 'mobile-history', { supervised: true });
  await harness.registerAgentWindow(projectId, agent.target, { label: 'mobile-history' });
  await page.addInitScript((token) => {
    sessionStorage.setItem('azito_ui_token', token);
    localStorage.setItem('azito-language', 'ja');
    const now = Date.now();
    localStorage.setItem('active-windows-finished', JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ serverName: 'local', target: `test:${i}`, finishedAt: now - i * 1000, seenAt: now }))));
  }, harness.uiToken);
  await page.goto(harness.baseUrl);
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('active-windows-finished') || '[]').length)).toBe(10);
  await page.getByRole('button', { name: '稼働ステータス' }).click();
  await expect(page.getByText(/履歴 10 \/ 10/)).toBeVisible();
  agent.setState('working');
  await expect(page.getByRole('dialog', { name: '稼働ステータス' }).getByText('稼働中 1')).toBeVisible();
  agent.setState('idle');
  await expect(page.getByText(/完了 ·/).first()).toBeVisible();
  await page.getByRole('button', { name: '履歴を消去' }).click();
  await expect(page.getByText(/履歴 10 \/ 10/)).toHaveCount(0);
  await expect(page.getByText(/完了 ·/).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => { document.body.style.zoom = '2'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('zero limit retains unread completions but removes confirmed history', async ({ page, harness }) => {
  await page.addInitScript((token) => {
    sessionStorage.setItem('azito_ui_token', token);
    const now = Date.now();
    localStorage.setItem('active-windows-retention', JSON.stringify({ maxCount: 0, retentionMs: 3600000 }));
    localStorage.setItem('active-windows-finished', JSON.stringify([
      { serverName: 'local', target: 'test:seen', finishedAt: now, seenAt: now },
      { serverName: 'local', target: 'test:unread', finishedAt: now },
    ]));
  }, harness.uiToken);
  await page.goto(harness.baseUrl);
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('active-windows-finished') || '[]').map((row: { target: string }) => row.target))).toEqual(['test:unread']);
});
