import fs from 'node:fs';
import { createTranscriptFixture } from '../fixtures/transcript';
import { test, expect } from '../fixtures/test';

test.use({ serviceWorkers: 'block' });

test('mobile agent defaults to chat and an explicit terminal choice survives resize and reload', async ({ app, harness }) => {
  const label = 'e2e-mobile-window-view';
  const projectId = await harness.createProject(label);
  const agent = await harness.startFakeAgent(label, 'scroll', { supervised: false });
  const windowId = await harness.registerAgentWindow(projectId, agent.target, { label });
  await app.setViewportSize({ width: 1280, height: 800 });
  await app.route(/\/api\/transcripts\/resolve-window\?/,  (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"failed"}' }));
  await app.goto(`${harness.baseUrl}/workspace/${projectId}`);
  await app.getByPlaceholder('タイトル・ID・ブランチで検索…').fill(label);
  await app.locator('.row-hover').first().click();
  await app.setViewportSize({ width: 390, height: 800 });
  const terminal = app.getByRole('button', { name: '端末で開く' });
  await expect(terminal).toBeVisible();
  expect((await terminal.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await terminal.click();
  await expect.poll(() => app.evaluate((id) => localStorage.getItem(`azito.windowView.${id}`), windowId)).toBe('terminal');
  await app.setViewportSize({ width: 1280, height: 800 });
  await app.setViewportSize({ width: 390, height: 800 });
  await app.reload();
  await expect(app.locator('.xterm').first()).toBeVisible();
  await expect(app.getByRole('button', { name: '端末で開く' })).toHaveCount(0);
  await harness.deleteWindow(windowId);
});

test('desktop defaults to terminal and mobile agent opens a conversation', async ({ app, harness }) => {
  const label = 'e2e-view-default-agent';
  const projectId = await harness.createProject(label);
  const agent = await harness.startFakeAgent(label, 'scroll', { supervised: false });
  const fixture = createTranscriptFixture(harness.claudeConfigDir, `-${label}`);
  fs.writeFileSync(fixture.filePath, JSON.stringify({ uuid: 'a1', type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: '会話の確認' }] } }) + '\n');
  const windowId = await harness.registerAgentWindow(projectId, agent.target, { label, agentSessionId: fixture.sessionId });
  await app.setViewportSize({ width: 1280, height: 800 });
  await app.goto(`${harness.baseUrl}/workspace/${projectId}`);
  await app.getByPlaceholder('タイトル・ID・ブランチで検索…').fill(label);
  await app.locator('.row-hover').first().click();
  await expect(app.locator('.xterm').first()).toBeVisible();
  expect(await app.evaluate((id) => localStorage.getItem(`azito.windowView.${id}`), windowId)).toBeNull();
  await app.setViewportSize({ width: 390, height: 800 });
  await expect(app.getByRole('region', { name: '会話ログ' })).toBeVisible();
  expect(await app.evaluate((id) => localStorage.getItem(`azito.windowView.${id}`), windowId)).toBeNull();
  await harness.deleteWindow(windowId);
});

test('mobile shell defaults to terminal', async ({ app, harness }) => {
  const label = 'e2e-view-default-shell';
  const projectId = await harness.createProject(label);
  const agent = await harness.startFakeAgent(label, 'scroll', { supervised: false });
  const { id } = await harness.api<{ id: number }>(`/projects/${projectId}/windows`, {
    method: 'POST', body: JSON.stringify({ server_name: 'local', tmux_target: agent.target, label, window_type: 'terminal' }),
  });
  await app.setViewportSize({ width: 1280, height: 800 });
  await app.goto(`${harness.baseUrl}/workspace/${projectId}`);
  await app.getByPlaceholder('タイトル・ID・ブランチで検索…').fill(label);
  await app.locator('.row-hover').first().click();
  await app.setViewportSize({ width: 390, height: 800 });
  await expect(app.locator('.xterm').first()).toBeVisible();
  expect(await app.evaluate((windowId) => localStorage.getItem(`azito.windowView.${windowId}`), id)).toBeNull();
  await harness.deleteWindow(id);
});

test('task information footer reflects the window it returns to', async ({ app, harness }) => {
  const title = 'e2e-task-footer-view';
  const projectId = await harness.createProject(title);
  const agent = await harness.startFakeAgent(title, 'scroll', { supervised: false });
  const { id: taskId } = await harness.api<{ id: number }>('/tasks', {
    method: 'POST', body: JSON.stringify({ project_id: projectId, server_name: 'local', title, description: 'footer test' }),
  });
  const { id: windowId } = await harness.api<{ id: number }>(`/tasks/${taskId}/windows`, {
    method: 'POST', body: JSON.stringify({ server_name: 'local', tmux_target: agent.target, window_type: 'agent' }),
  });
  await app.setViewportSize({ width: 390, height: 800 });
  await app.addInitScript(({ taskId, projectId, title }) => {
    const id = `task:${taskId}`;
    localStorage.setItem('workspace-tabs', JSON.stringify([{ id, type: 'task', label: title, entityId: taskId, projectId }]));
    localStorage.setItem('workspace-tabs-active', id);
    localStorage.setItem('workspace-subtab-task', JSON.stringify({ [taskId]: { layout: { type: 'pane', id: 'p1', tabIds: ['v-description'], activeTabId: 'v-description' }, focusedPaneId: 'p1' } }));
  }, { taskId, projectId, title });
  await app.goto(`${harness.baseUrl}/workspace/${projectId}`);
  const menu = app.getByRole('button', { name: 'その他の操作' });
  const toggle = app.getByRole('tablist', { name: '表示モード' });
  await expect(toggle.getByRole('tab', { name: 'チャット' })).toHaveAttribute('aria-selected', 'true');
  await toggle.getByRole('tab', { name: 'チャット' }).click();
  expect(await app.evaluate((id) => localStorage.getItem(`azito.windowView.${id}`), windowId)).toBe('chat');
  await menu.click();
  await app.getByText('説明', { exact: true }).last().click();
  await toggle.getByRole('tab', { name: '端末' }).click();
  expect(await app.evaluate((id) => localStorage.getItem(`azito.windowView.${id}`), windowId)).toBe('terminal');
});

test('task window defaults to chat when saved layout has no focused pane', async ({ app, harness }) => {
  const title = 'e2e-task-unfocused-window';
  const projectId = await harness.createProject(title);
  const agent = await harness.startFakeAgent(title, 'scroll', { supervised: false });
  const { id: taskId } = await harness.api<{ id: number }>('/tasks', {
    method: 'POST', body: JSON.stringify({ project_id: projectId, server_name: 'local', title }),
  });
  const { id: windowId } = await harness.api<{ id: number }>(`/tasks/${taskId}/windows`, {
    method: 'POST', body: JSON.stringify({ server_name: 'local', tmux_target: agent.target, window_type: 'agent' }),
  });
  await app.setViewportSize({ width: 390, height: 800 });
  await app.route(/\/api\/transcripts\/resolve-window\?/, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"failed"}' }));
  await app.addInitScript(({ taskId, projectId, title, target }) => {
    const id = `task:${taskId}`;
    const windowTab = `v-window:local::${target.replace(/\.\d+$/, '')}`;
    localStorage.setItem('workspace-tabs', JSON.stringify([{ id, type: 'task', label: title, entityId: taskId, projectId }]));
    localStorage.setItem('workspace-tabs-active', id);
    localStorage.setItem('workspace-subtab-task', JSON.stringify({ [taskId]: { layout: { type: 'pane', id: 'p1', tabIds: [windowTab], activeTabId: windowTab } } }));
  }, { taskId, projectId, title, target: agent.target });
  await app.goto(`${harness.baseUrl}/workspace/${projectId}`);
  await expect(app.getByRole('button', { name: '端末で開く' })).toBeVisible();
  expect(await app.evaluate((id) => localStorage.getItem(`azito.windowView.${id}`), windowId)).toBeNull();
});
