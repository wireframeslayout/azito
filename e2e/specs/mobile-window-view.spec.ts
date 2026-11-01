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
    method: 'POST', body: JSON.stringify({ server_name: 'local', tmux_target: agent.target, label, window_type: 'shell' }),
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
