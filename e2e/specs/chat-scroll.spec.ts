// 長い会話のチャットを開いたとき、初期表示が最新メッセージの位置から始まることを検証する。
// 以前は rAF の1回きりスクロール + content-visibility の仮高さ（200px）のせいで、実高さ確定前に
// スクロールが空振りして途中で止まっていた。

import { test, expect } from '../fixtures/test';
import { createTranscriptFixture } from '../fixtures/transcript';

const TMUX_SESSION = 'e2e-scroll';
const NEAR_BOTTOM_PX = 80;
const SETTLE_BUDGET_MS = 10_000;

test('長い会話のチャットは最新メッセージの位置から表示される', async ({ app, harness }) => {
  const label = 'e2e-scroll';
  const projectId = await harness.createProject('e2e-chat-scroll');

  const agent = await harness.startFakeAgent(TMUX_SESSION, 'scroll', { supervised: false });
  const fixture = createTranscriptFixture(harness.claudeConfigDir, '-e2e-scroll');
  const marker = fixture.writeLongConversation(40, 80);
  const windowId = await harness.registerAgentWindow(projectId, agent.target, { label, agentSessionId: fixture.sessionId });

  await app.setViewportSize({ width: 1280, height: 800 });
  await app.addInitScript(([id]) => {
    localStorage.setItem(`azito.windowView.${id}`, 'chat');
  }, [windowId]);

  await app.goto(`${harness.baseUrl}/workspace/${projectId}`);
  await app.getByPlaceholder('タイトル・ID・ブランチで検索…').fill(label);
  await app.locator('.row-hover').filter({ hasText: label }).first().click();

  const log = app.getByRole('region', { name: '会話ログ' });
  await expect(log).toBeVisible();

  await expect.poll(
    () => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    { timeout: SETTLE_BUDGET_MS },
  ).toBeLessThan(NEAR_BOTTOM_PX);
  await expect(app.getByText(marker)).toBeVisible();

  await harness.deleteWindow(windowId);
});
