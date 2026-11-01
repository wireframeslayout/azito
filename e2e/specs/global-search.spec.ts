import { test, expect } from '../fixtures/test';

test.use({ serviceWorkers: 'block' });

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


test('別プロジェクトのタスクを開く', async ({ app, harness }) => {
  const first = await harness.createProject('search-task-first');
  const second = await harness.createProject('search-task-second');
  const task = await harness.api<{ id: number }>('/tasks', { method: 'POST', body: JSON.stringify({ project_id: second, title: 'Cross project task' }) });
  await app.goto(`${harness.baseUrl}/workspace/${first}`);
  await app.getByRole('button', { name: '検索', exact: true }).click();
  const input = app.getByRole('combobox', { name: '検索' });
  await input.fill(`#${task.id}`);
  await expect(app.getByRole('option', { name: /Cross project task/ })).toBeVisible();
  await input.press('Enter');
  await expect(app).toHaveURL(new RegExp(`/workspace/${second}`));
  await expect(app.getByText('Cross project task').first()).toBeVisible();
});

test('モバイルのメニューから検索しシートを閉じる', async ({ app, harness }) => {
  const project = await harness.createProject('search-mobile');
  await app.setViewportSize({ width: 320, height: 800 });
  await app.goto(`${harness.baseUrl}/workspace/${project}`);
  await app.getByRole('button', { name: 'メニュー', exact: true }).click();
  const opener = app.getByRole('button', { name: '検索', exact: true });
  await opener.click();
  const input = app.getByRole('combobox', { name: '検索' });
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute('enterkeyhint', 'search');
  expect(await app.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await input.press('Escape');
  await expect(opener).toHaveCount(0);
  await expect(app.getByRole('button', { name: 'メニュー', exact: true })).toBeFocused();
});

test('スマホでタスクを開くとナビシートが閉じる', async ({ app, harness }) => {
  const project = await harness.createProject('search-mobile-task');
  const task = await harness.api<{ id: number }>('/tasks', { method: 'POST', body: JSON.stringify({ project_id: project, title: 'Mobile search task' }) });
  await app.setViewportSize({ width: 390, height: 800 });
  await app.goto(`${harness.baseUrl}/workspace/${project}`);
  await app.getByRole('button', { name: 'メニュー', exact: true }).click();
  await app.getByRole('button', { name: '検索', exact: true }).click();
  const input = app.getByRole('combobox', { name: '検索' });
  await input.fill(`#${task.id}`);
  await input.press('Enter');
  await expect(app.getByRole('dialog', { name: '検索' })).toHaveCount(0);
  await expect(app.getByText('Mobile search task').first()).toBeVisible();
  await expect(app.getByRole('button', { name: '検索', exact: true })).toHaveCount(0);
});

test('端末に連続した空白を入力しても検索を開かない', async ({ app, harness }) => {
  const project = await harness.createProject('search-terminal');
  const agent = await harness.startFakeAgent('search-terminal', 'agent', { supervised: false, recordInput: true });
  const id = await harness.registerAgentWindow(project, agent.target, { label: 'search-terminal-window' });
  await app.goto(`${harness.baseUrl}/workspace/${project}`);
  await app.getByRole('button', { name: '検索', exact: true }).click();
  const input = app.getByRole('combobox', { name: '検索' });
  await input.fill(`W-${id}`);
  await expect(app.getByRole('option', { name: new RegExp(`W-${id}`) })).toBeVisible();
  await input.press('Enter');
  const terminal = app.locator('.xterm').first();
  await expect(terminal).toBeVisible();
  await terminal.click();
  await app.keyboard.type('a  b');
  await expect.poll(() => agent.readInput()).toContain('a  b');
  await expect(app.getByRole('dialog', { name: '検索' })).toHaveCount(0);
});

test('サーバーの取得失敗を表示し再取得する', async ({ app, harness }) => {
  const project = await harness.createProject('search-retry');
  const agent = await harness.startFakeAgent('search-retry', 'agent', { supervised: false });
  const id = await harness.registerAgentWindow(project, agent.target);
  await app.goto(`${harness.baseUrl}/workspace/${project}`);
  let fail = true;
  let intercepted = 0;
  await app.route(url => url.pathname === '/api/servers/local/sessions' && url.searchParams.get('detail') === '1', async route => {
    intercepted++;
    if (fail) await route.abort();
    else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [], unavailable: [] }) });
  });
  await app.getByRole('button', { name: '検索', exact: true }).click();
  await expect(app.getByText(/一部のサーバーに接続できないため/)).toContainText('local');
  const input = app.getByRole('combobox', { name: '検索' });
  await input.fill(`W-${id}`);
  await expect(app.getByRole('option')).toContainText('オフライン');
  expect(intercepted).toBeGreaterThan(0);
  fail = false;
  await app.getByRole('button', { name: '再取得' }).click();
  await expect(app.getByText(/一部のサーバーに接続できないため/)).toHaveCount(0);
});
