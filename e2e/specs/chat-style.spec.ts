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
        { type: 'text', text: '## 見出し\n\n本文の段落です。\n\n次の段落です。\n\n| 名前 | 数量 | 詳細 | 備考 | 状態 | 種別 | 担当 | 部門 | 場所 | 日付 | 対応 | 結果 |\n| --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| 項目 | 12 円 | 説明 | 注記 | 確認 | 分類 | 担当 | 部門 | 場所 | 日付 | 対応 | 結果 |' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'first' } },
      ] } },
      { uuid: 'u1', type: 'user', timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'failed', is_error: true }] } },
      { uuid: 'a2', type: 'assistant', timestamp, message: { role: 'assistant', model: 'claude-e2e', content: [{ type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: 'file.txt' } }] } },
      { uuid: 'a3', type: 'assistant', timestamp, message: { role: 'assistant', model: 'claude-e2e', content: [{ type: 'tool_use', id: 'tool-3', name: 'Write', input: { file_path: 'other.txt' } }] } },
      { uuid: 'u2', type: 'user', timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'done' }] } },
      { uuid: 'a4', type: 'assistant', timestamp, message: { role: 'assistant', model: 'claude-e2e', content: [{ type: 'text', text: '単独ツールの説明' }, { type: 'tool_use', id: 'tool-4', name: 'Glob', input: { pattern: '*.ts' } }] } },
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
    await expect(table.locator('th').nth(1)).toHaveCSS('text-align', 'right');
    const paragraph = log.locator('.md-content p').first();
    expect(parseFloat(await paragraph.evaluate((el) => getComputedStyle(el).marginBottom))).toBeGreaterThan(0);
    expect(await table.locator('th').first().evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    await expect.poll(() => app.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect.poll(() => table.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const summary = log.locator('.tool-run > summary');
    await expect(summary).toContainText('ツール 3 件');
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
    if (style === 'bubble') {
      const singleTool = log.getByText('Glob', { exact: true });
      await expect(singleTool).toBeVisible();
      const card = singleTool.locator('xpath=ancestor::details/..');
      await expect(card.getByText('単独ツールの説明')).toBeVisible();
    }
    for (const design of ['shade', 'wired']) {
      await app.evaluate((value) => document.documentElement.setAttribute('data-design', value), design);
      const border = await table.locator('th').first().evaluate((el) => getComputedStyle(el).borderBottomColor);
      expect(border).not.toBe('rgba(0, 0, 0, 0)');
      const ratios = await paragraph.evaluate((el) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d')!;
        const layers: Element[] = [];
        for (let node: Element | null = el; node; node = node.parentElement) layers.unshift(node);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, 1, 1);
        for (const node of layers) {
          ctx.fillStyle = getComputedStyle(node).backgroundColor;
          ctx.fillRect(0, 0, 1, 1);
        }
        const background = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
        ctx.fillStyle = getComputedStyle(el).color;
        ctx.fillRect(0, 0, 1, 1);
        const foreground = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
        const luminance = (rgb: number[]) => rgb.map((v) => v / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
        const a = luminance(foreground), b = luminance(background);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      expect(ratios).toBeGreaterThanOrEqual(4.5);
    }
    await harness.deleteWindow(windowId);
  });
}
