import { test, expect } from '../fixtures/test';

test('switches registered windows and releases the extra terminal connection', async ({ app, harness }) => {
  const project = await harness.createProject('maximize-e2e');
  const firstAgent = await harness.startFakeAgent('maximize-first', 'agent', { supervised: false });
  const secondAgent = await harness.startFakeAgent('maximize-second', 'agent', { supervised: false });
  const first = await harness.registerAgentWindow(project, firstAgent.target, { label: 'maximize-first' });
  const second = await harness.registerAgentWindow(project, secondAgent.target, { label: 'maximize-second' });
  const connections = new Set<object>();
  app.on('websocket', socket => {
    const url = new URL(socket.url());
    if (url.searchParams.has('windowId')) {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
    }
  });
  await app.goto(`${harness.baseUrl}/workspace/${project}`);
  for (const id of [first, second]) {
    await app.getByRole('button', { name: '検索', exact: true }).click();
    const search = app.getByRole('combobox', { name: '検索' });
    await search.fill(`W-${id}`);
    await expect(app.getByRole('option', { name: new RegExp(`W-${id}`) })).toBeVisible();
    await search.press('Enter');
    await expect(app.locator('.xterm').first()).toBeVisible();
    if (id === first) {
      await app.locator(`[data-tab-id*="::w${id}."]`).first().click({ button: 'right' });
      await app.getByText('タブをピン留め', { exact: true }).click();
    }
  }
  await app.locator(`[data-tab-id*="::w${second}."]`).first().click();
  await expect.poll(() => connections.size).toBeGreaterThan(0);
  const baseline = connections.size;
  await app.keyboard.press('Control+Shift+M');
  const dialog = app.getByRole('dialog');
  await expect(dialog.locator('header')).toContainText(`W-${second}`);
  await expect.poll(() => connections.size).toBe(baseline + 1);
  await dialog.getByRole('treeitem', { name: new RegExp(`W-${first}`) }).click();
  await expect(dialog.locator('header')).toContainText(`W-${first}`);
  await expect.poll(() => connections.size).toBe(baseline + 1);
  await app.keyboard.press('Control+Shift+M');
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => connections.size).toBe(baseline);
});

test('opens a linked card in the maximize dialog', async ({ app, harness }) => {
  const project = await harness.createProject('maximize-linked');
  const sourceAgent = await harness.startFakeAgent('maximize-linked-source', 'agent', { supervised: false });
  const targetAgent = await harness.startFakeAgent('maximize-linked-target', 'agent', { supervised: false });
  const source = await harness.registerAgentWindow(project, sourceAgent.target, { label: 'source' });
  const target = await harness.registerAgentWindow(project, targetAgent.target, { label: 'linked-target' });
  await harness.api(`/windows/${source}/role`, { method: 'PUT', body: JSON.stringify({ role: 'orchestrator' }) });
  await harness.api(`/windows/${source}/links`, { method: 'POST', body: JSON.stringify({ targetWindowId: target }) });
  await app.goto(`${harness.baseUrl}/orchestration/${source}`);
  await app.getByRole('button', { name: '連携中の窓を開く' }).click();
  const panel = app.getByRole('complementary', { name: /連携中/ });
  const card = panel.locator('article').filter({ hasText: 'linked-target' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '開く', exact: true }).click();
  const dialog = app.getByRole('dialog');
  await expect(dialog.locator('header')).toContainText(`W-${target}`);
  await dialog.getByRole('button', { name: '閉じる' }).click();
  await expect(dialog).toHaveCount(0);
  await app.getByRole('treeitem', { name: 'source', exact: true }).click({ button: 'right' });
  await app.getByRole('button', { name: '窓を拡大' }).click();
  await expect(dialog.getByRole('tree', { name: /sourceの連携中/ })).toBeVisible();
  await dialog.getByRole('treeitem', { name: /linked-target/ }).click();
  await expect(dialog.locator('header')).toContainText(`W-${target}`);
  await dialog.getByRole('button', { name: '閉じる' }).click();
});
