import { test, expect } from '../fixtures/test';

test('registered windows outside maximize do not gain a chat toggle', async ({ app, harness }) => {
  const project = await harness.createProject('scope-regression');
  const agent = await harness.startFakeAgent('scope-regression', 'agent', { supervised: false });
  const id = await harness.registerAgentWindow(project, agent.target, { label: 'scope-regression-window' });
  await harness.api(`/windows/${id}/role`, { method: 'PUT', body: JSON.stringify({ role: 'orchestrator' }) });
  await app.goto(`${harness.baseUrl}/orchestration/${id}`);
  await expect(app.locator('.xterm').first()).toBeVisible();
  await expect(app.getByRole('tab', { name: 'チャット' })).toHaveCount(0);
  const connected: string[] = [];
  app.on('websocket', socket => connected.push(socket.url()));
  await app.goto(`${harness.baseUrl}/servers/local/windows`);
  await app.locator('button:has(svg.lucide-chevron-down):visible').first().click({ timeout: 10000 });
  await app.getByText(new RegExp(`W-${id}`)).last().click({ timeout: 10000 });
  await expect(app.locator('.xterm').first()).toBeVisible();
  await expect.poll(() => connected.some(url => new URL(url).searchParams.get('windowId') === String(id))).toBe(true);
  await expect(app.getByRole('tab', { name: 'チャット' })).toHaveCount(0);
});
