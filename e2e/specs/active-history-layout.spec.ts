import { test, expect } from '../fixtures/test';
test('keeps active and finished rows at the same height', async ({ app, harness }) => {
  const project = await harness.createProject('Sample history');
  const working = await harness.startFakeAgent('history-check', 'working', { supervised: true });
  const blocked = await harness.startFakeAgent('history-check', 'blocked', { supervised: true });
  const workingId = await harness.registerAgentWindow(project, working.target, { label: 'Working sample' });
  const blockedId = await harness.registerAgentWindow(project, blocked.target, { label: 'Blocked sample' });
  await app.addInitScript(() => { localStorage.setItem('active-windows-finished', JSON.stringify([{ serverName: 'local', target: 'sample:1', finishedAt: Date.now() - 60000, seenAt: Date.now() - 30000 }, { serverName: 'local', target: 'sample:2', finishedAt: Date.now() - 20000 }])); localStorage.setItem('active-windows-collapsed', '0'); });
  await app.setViewportSize({ width: 1200, height: 700 });
  await app.goto(`${harness.baseUrl}/workspace/${project}`);
  working.setState('working'); blocked.setState('blocked');
  const rows = app.locator('.aw-history-row');
  await expect(rows.filter({ has: app.locator('.aw-braille-spinner') }).filter({ hasText: new RegExp(`W-${workingId}`) })).toBeVisible({ timeout: 12000 });
  await expect(rows.filter({ hasText: new RegExp(`W-${blockedId}`) }).locator('.aw-blocked-dot')).toBeVisible({ timeout: 20000 });
  await expect(rows).toHaveCount(4);
  const sizes = await rows.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
  expect(new Set(sizes).size).toBe(1);
});
