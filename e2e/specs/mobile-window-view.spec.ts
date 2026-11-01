import { test, expect } from '../fixtures/test';

test('mobile agent defaults to chat and an explicit terminal choice survives resize and reload', async ({ app, harness }) => {
  const label = 'e2e-mobile-window-view';
  const projectId = await harness.createProject(label);
  const agent = await harness.startFakeAgent(label, 'scroll', { supervised: false });
  const windowId = await harness.registerAgentWindow(projectId, agent.target, { label });
  await app.setViewportSize({ width: 390, height: 800 });
  await app.route('**/api/transcripts/resolve-window?*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"failed"}' }));
  await app.goto(`${harness.baseUrl}/workspace/${projectId}`);
  await app.getByPlaceholder('タイトル・ID・ブランチで検索…').fill(label);
  await app.locator('.row-hover').first().click();
  const terminal = app.getByRole('button', { name: '端末で開く' });
  await expect(terminal).toBeVisible();
  expect((await terminal.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await terminal.click();
  await expect.poll(() => app.evaluate((id) => localStorage.getItem(`azito.windowView.${id}`), windowId)).toBe('terminal');
  await app.setViewportSize({ width: 1280, height: 800 });
  await app.setViewportSize({ width: 390, height: 800 });
  await app.reload();
  await expect(app.getByRole('button', { name: '端末で開く' })).toHaveCount(0);
  await harness.deleteWindow(windowId);
});
