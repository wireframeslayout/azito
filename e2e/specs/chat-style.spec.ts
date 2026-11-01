import fs from 'node:fs';
import { test, expect } from '../fixtures/test';
import { createTranscriptFixture } from '../fixtures/transcript';

for (const style of ['flow', 'bubble'] as const) {
  test(`${style}: Markdown と連続ツールを狭幅でも操作できる`, async ({ app, harness }) => {
    const label = `e2e-style-${style}`;
    const projectId = await harness.createProject(label);
    const agent = await harness.startFakeAgent(label, 'scroll', { supervised: false });
    const fixture = createTranscriptFixture(harness.claudeConfigDir, `-${label}`);
    const timestamp = new Date().toISOString();
    const records = [
      { uuid: 'a1', type: 'assistant', timestamp, message: { role: 'assistant', model: 'claude-e2e', content: [
        { type: 'text', text: '## 見出し\n\n本文の段落です。\n\n| 名前 | 数量 | 詳細 | 備考 | 状態 | 種別 | 担当 | 部門 | 場所 | 日付 | 対応 | 結果 |\n| --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| 項目 | 12 円 | 説明 | 注記 | 確認 | 分類 | 担当 | 部門 | 場所 | 日付 | 対応 | 結果 |' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'first' } },
      ] } },
      { uuid: 'u1', type: 'user', timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'failed', is_error: true }] } },
      { uuid: 'a2', type: 'assistant', timestamp, message: { role: 'assistant', model: 'claude-e2e', content: [{ type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: 'file.txt' } }] } },
      { uuid: 'u2', type: 'user', timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'done' }] } },
    ];
    fs.writeFileSync(fixture.filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const windowId = await harness.registerAgentWindow(projectId, agent.target, { label, agentSessionId: fixture.sessionId });
    await app.setViewportSize({ width: 1280, height: 800 });
    await app.addInitScript(([id, viewStyle]) => {
      localStorage.setItem(`azito.windowView.${id}`, 'chat');
      localStorage.setItem('azito.transcript.style', viewStyle);
    }, [windowId, style] as const);
    await app.goto(`${harness.baseUrl}/workspace/${projectId}`);
    await app.getByPlaceholder('タイトル・ID・ブランチで検索…').fill(label);
    await app.locator('.row-hover').first().click();
    const log = app.getByRole('region', { name: '会話ログ' });
    await expect(log).toBeVisible();
    await app.setViewportSize({ width: 320, height: 800 });
    const table = log.locator('.md-table-wrap');
    await expect(table).toBeVisible();
    await expect(table.locator('td.md-numeric')).toHaveText('12 円');
    await expect.poll(() => table.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const summary = log.locator('.tool-run > summary');
    await expect(summary).toContainText('ツール 2 件');
    await expect(summary).toContainText('失敗 1 件');
    expect((await summary.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await expect.poll(() => log.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await log.evaluate((el) => { el.style.zoom = '2'; });
    await expect.poll(() => log.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await log.evaluate((el) => { el.style.zoom = ''; });
    await summary.focus();
    await expect(summary).toBeFocused();
    await app.keyboard.press('Enter');
    await expect(summary.locator('..')).toHaveAttribute('open', '');
    await expect(log.getByText('Bash', { exact: true })).toBeVisible();
    for (const design of ['shade', 'wired']) {
      await app.evaluate((value) => document.documentElement.setAttribute('data-design', value), design);
      const border = await table.locator('td').first().evaluate((el) => getComputedStyle(el).borderTopColor);
      expect(border).not.toBe('rgba(0, 0, 0, 0)');
    }
    await harness.deleteWindow(windowId);
  });
}
