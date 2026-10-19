// ペインを削除したあと、サイドバーから削除した行が消え、残りの行が自分のハンドルのまま表示されることを検証する。
// 行のバッジは位置（index）ではなくペインハンドルから作るため、兄弟の削除で番号が振り直されても
// 「削除した行が残って見える」状態にならない（#475）。

import { test, expect } from '../fixtures/test';

const TMUX_SESSION = 'e2e-pane-del';

test('tmux: ペインを削除するとサイドバーからその行だけが消える', async ({ app, harness }) => {
  const label = 'e2e-pane-del';
  const projectId = await harness.createProject('e2e-pane-delete-sidebar');
  const agent = await harness.startFakeAgent(TMUX_SESSION, 'panes', { supervised: false });
  await harness.tmux(['split-window', '-d', '-t', agent.target]);
  await harness.tmux(['split-window', '-d', '-t', agent.target]);
  const { stdout } = await harness.tmux(['list-panes', '-t', agent.target, '-F', '#{pane_id}']);
  const handles = stdout.trim().split('\n');
  expect(handles).toHaveLength(3);
  const [first, second, third] = handles;
  await harness.registerAgentWindow(projectId, agent.target, { label });

  await app.setViewportSize({ width: 1280, height: 800 });
  await app.goto(`${harness.baseUrl}/workspace/${projectId}`);
  await app.getByPlaceholder('タイトル・ID・ブランチで検索…').fill(label);
  // ウィンドウ行は表示名（ウィンドウ名由来）で出るので、プロジェクトに1つだけの行の展開ボタンを開く。
  const expander = app.locator('[role="button"][aria-expanded="false"]').first();
  await expect(expander).toBeVisible({ timeout: 20_000 });
  await expander.click();

  for (const handle of handles) await expect(app.getByText(handle, { exact: true })).toBeVisible();

  await app.getByText(second, { exact: true }).click({ button: 'right' });
  await app.getByText('ペインを削除', { exact: true }).click();
  await expect(app.getByText(/を終了しますか/)).toBeVisible();
  await app.getByRole('button', { name: '確認', exact: true }).click();

  await expect(app.getByText(second, { exact: true })).toHaveCount(0, { timeout: 15_000 });
  await expect(app.getByText(first, { exact: true })).toBeVisible();
  await expect(app.getByText(third, { exact: true })).toBeVisible();
});
